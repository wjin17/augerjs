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
        .prepare(
          "INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)"
        )
        .run(filePath, language, extracted.hash, Date.now());

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line, parent_id, is_anonymous)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertEdge = this.db.prepare(
        "INSERT OR IGNORE INTO call_edges (caller_id, callee_name) VALUES (?, ?)"
      );

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

      this.db.exec(`
        UPDATE call_edges
        SET callee_id = (
          SELECT id FROM symbols WHERE symbols.name = call_edges.callee_name LIMIT 1
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
