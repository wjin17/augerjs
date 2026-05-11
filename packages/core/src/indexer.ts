import type Database from "better-sqlite3";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "./parsers/typescript.js";
import { parseRubyFile } from "./parsers/ruby.js";

export class Indexer {
  private project = new Project({ useInMemoryFileSystem: false });

  constructor(private db: Database.Database) {}

  indexFile(filePath: string, language: "typescript" | "ruby") {
    let extracted;
    try {
      extracted =
        language === "typescript"
          ? parseTypeScriptFile(filePath, this.project)
          : parseRubyFile(filePath);
    } catch (err) {
      console.error(`[auger] parse error in ${filePath}:`, err);
      return;
    }

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      this.db
        .prepare("INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)")
        .run(filePath, language, extracted.hash, Date.now());

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line, parent_id, is_anonymous)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertEdge = this.db.prepare(
        "INSERT OR IGNORE INTO call_edges (caller_id, callee_name) VALUES (?, ?)"
      );

      const insertImport = this.db.prepare(
        "INSERT OR REPLACE INTO imports (file_path, local_name, exported_name, source_path) VALUES (?, ?, ?, ?)"
      );
      for (const imp of extracted.imports) {
        insertImport.run(filePath, imp.localName, imp.exportedName, imp.sourcePath);
      }

      const parentIds = new Map<string, number>();
      for (const sym of extracted.symbols) {
        if (sym.parentName === null) {
          const result = insertSymbol.run(
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.docstring,
            sym.startLine,
            sym.endLine,
            null,
            sym.isAnonymous ? 1 : 0
          );
          parentIds.set(sym.name, Number(result.lastInsertRowid));
        }
      }

      for (const sym of extracted.symbols) {
        if (sym.parentName !== null) {
          const parentId = parentIds.get(sym.parentName) ?? null;
          const result = insertSymbol.run(
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.docstring,
            sym.startLine,
            sym.endLine,
            parentId,
            sym.isAnonymous ? 1 : 0
          );
          for (const callee of sym.callees) {
            insertEdge.run(Number(result.lastInsertRowid), callee);
          }
        } else {
          const id = parentIds.get(sym.name);
          if (id !== undefined) {
            for (const callee of sym.callees) insertEdge.run(id, callee);
          }
        }
      }

      // Pass 1: same-file resolution (fastest, most precise)
      this.db.exec(`
        UPDATE call_edges
        SET callee_id = (
          SELECT s.id FROM symbols s
          WHERE s.name = call_edges.callee_name
          AND s.file_path = (SELECT s2.file_path FROM symbols s2 WHERE s2.id = call_edges.caller_id)
          AND s.is_anonymous = 0
          LIMIT 1
        )
        WHERE callee_id IS NULL
      `);

      // Pass 2: import-based cross-file resolution
      this.db.exec(`
        UPDATE call_edges
        SET callee_id = (
          SELECT s.id FROM symbols s
          JOIN imports i ON i.source_path = s.file_path AND i.exported_name = s.name
          WHERE i.file_path = (SELECT s2.file_path FROM symbols s2 WHERE s2.id = call_edges.caller_id)
          AND i.local_name = call_edges.callee_name
          AND s.is_anonymous = 0
          LIMIT 1
        )
        WHERE callee_id IS NULL
      `);

      // Pass 3: wildcard cross-file resolution (Ruby require_relative)
      this.db.exec(`
        UPDATE call_edges
        SET callee_id = (
          SELECT s.id FROM symbols s
          JOIN imports i ON i.source_path = s.file_path AND i.exported_name = '*'
          WHERE i.file_path = (SELECT s2.file_path FROM symbols s2 WHERE s2.id = call_edges.caller_id)
          AND s.name = call_edges.callee_name
          AND s.is_anonymous = 0
          LIMIT 1
        )
        WHERE callee_id IS NULL
      `);
    });

    tx();
  }

  removeFile(filePath: string) {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }
}
