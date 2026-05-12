import type Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "./parsers/typescript.js";
import { parseRubyFile, type RubyParseOptions } from "./parsers/ruby.js";
import type { ExtractedFile } from "./parsers/typescript.js";

type WorkerResult = {
  results: ExtractedFile[];
  errors: Array<{ path: string; error: string }>;
};

export class Indexer {
  private project = new Project({ useInMemoryFileSystem: false });
  private deleteFileStmt: Database.Statement;
  private insertFileStmt: Database.Statement;
  private insertSymbolStmt: Database.Statement;
  private insertEdgeStmt: Database.Statement;
  private insertImportStmt: Database.Statement;

  constructor(private db: Database.Database, private rails: boolean = false) {
    this.deleteFileStmt = db.prepare("DELETE FROM files WHERE path = ?");
    this.insertFileStmt = db.prepare(
      "INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)"
    );
    this.insertSymbolStmt = db.prepare(`
      INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line, parent_id, is_anonymous)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertEdgeStmt = db.prepare(
      "INSERT OR IGNORE INTO call_edges (caller_id, callee_name) VALUES (?, ?)"
    );
    this.insertImportStmt = db.prepare(
      "INSERT OR REPLACE INTO imports (file_path, local_name, exported_name, source_path) VALUES (?, ?, ?, ?)"
    );
  }

  indexFile(filePath: string, language: "typescript" | "ruby") {
    let extracted: ExtractedFile;
    try {
      extracted =
        language === "typescript"
          ? parseTypeScriptFile(filePath, this.project)
          : parseRubyFile(filePath, { rails: this.rails });
    } catch (err) {
      console.error(`[auger] parse error in ${filePath}:`, err);
      return;
    }

    const tx = this.db.transaction(() => {
      this.insertOne(extracted, filePath, language, Date.now());
      this.resolveEdges();
    });
    tx();
  }

  async bulkIndex(
    files: Array<{ path: string; language: "typescript" | "ruby" }>
  ): Promise<{ elapsed: number }> {
    const t0 = Date.now();

    if (files.length === 0) return { elapsed: 0 };

    const workerCount = Math.max(1, Math.min(cpus().length, files.length));
    const chunkSize = Math.ceil(files.length / workerCount);
    const chunks = Array.from({ length: workerCount }, (_, i) =>
      files.slice(i * chunkSize, (i + 1) * chunkSize)
    ).filter((c) => c.length > 0);

    const workerUrl = new URL("./parser-worker.js", import.meta.url);

    const workerResults = await Promise.all(
      chunks.map(
        (chunk) =>
          new Promise<WorkerResult>((resolve, reject) => {
            const worker = new Worker(workerUrl, { workerData: { files: chunk, rails: this.rails } });
            worker.once("message", resolve);
            worker.once("error", reject);
          })
      )
    );

    const allParsed = workerResults.flatMap((r) => r.results);
    for (const { path, error } of workerResults.flatMap((r) => r.errors)) {
      console.error(`[auger] parse error in ${path}:`, error);
    }

    if (allParsed.length > 0) {
      const now = Date.now();
      const tx = this.db.transaction(() => {
        for (const extracted of allParsed) {
          this.insertOne(extracted, extracted.path, extracted.language, now);
        }
        this.resolveEdges();
      });
      tx();
    }

    return { elapsed: Date.now() - t0 };
  }

  removeFile(filePath: string) {
    this.deleteFileStmt.run(filePath);
  }

  private insertOne(
    extracted: ExtractedFile,
    filePath: string,
    language: "typescript" | "ruby",
    now: number
  ) {
    this.deleteFileStmt.run(filePath);
    this.insertFileStmt.run(filePath, language, extracted.hash, now);

    for (const imp of extracted.imports) {
      this.insertImportStmt.run(filePath, imp.localName, imp.exportedName, imp.sourcePath);
    }

    const parentIds = new Map<string, number>();
    for (const sym of extracted.symbols) {
      if (sym.parentName === null) {
        const result = this.insertSymbolStmt.run(
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
        const result = this.insertSymbolStmt.run(
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
          this.insertEdgeStmt.run(Number(result.lastInsertRowid), callee);
        }
      } else {
        const id = parentIds.get(sym.name);
        if (id !== undefined) {
          for (const callee of sym.callees) this.insertEdgeStmt.run(id, callee);
        }
      }
    }
  }

  private resolveEdges() {
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

    // Pass 4: global Ruby name resolution (Rails autoloading — no explicit require)
    this.db.exec(`
      UPDATE call_edges
      SET callee_id = (
        SELECT s.id FROM symbols s
        JOIN files f ON f.path = s.file_path
        WHERE s.name = call_edges.callee_name
        AND s.is_anonymous = 0
        AND f.language = 'ruby'
        LIMIT 1
      )
      WHERE callee_id IS NULL
      AND caller_id IN (
        SELECT s.id FROM symbols s
        JOIN files f ON f.path = s.file_path
        WHERE f.language = 'ruby'
      )
    `);
  }
}
