import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb } from "./db/index";
import { Indexer } from "./indexer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "../../../fixtures");
const tsFixture = `${fixtures}/typescript/sample.ts`;
const rbFixture = `${fixtures}/ruby/sample.rb`;

describe("Indexer", () => {
  let db: Database.Database;
  let indexer: Indexer;

  beforeEach(() => {
    db = openDb(":memory:");
    indexer = new Indexer(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("indexFile — TypeScript", () => {
    it("stores all symbols", () => {
      indexer.indexFile(tsFixture, "typescript");
      const names = (db.prepare("SELECT name FROM symbols").all() as { name: string }[])
        .map((r) => r.name)
        .sort();
      expect(names).toEqual([
        "Greeter", "User", "UserId", "add", "double", "formatName", "greet", "greetAsync", "identity",
      ]);
    });

    it("stores the file record with correct language", () => {
      indexer.indexFile(tsFixture, "typescript");
      const file = db.prepare("SELECT language FROM files WHERE path = ?").get(tsFixture) as
        | { language: string }
        | undefined;
      expect(file?.language).toBe("typescript");
    });

    it("stores call edges", () => {
      indexer.indexFile(tsFixture, "typescript");
      const edges = (
        db.prepare("SELECT callee_name FROM call_edges").all() as { callee_name: string }[]
      ).map((r) => r.callee_name);
      expect(edges).toContain("formatName");
    });

    it("resolves callee_id for known symbols", () => {
      indexer.indexFile(tsFixture, "typescript");
      const resolved = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'formatName'")
        .get() as { callee_id: number | null } | undefined;
      expect(resolved?.callee_id).not.toBeNull();
    });

    it("indexes symbols into FTS", () => {
      indexer.indexFile(tsFixture, "typescript");
      const rows = db
        .prepare("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'add'")
        .all();
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("indexFile — Ruby", () => {
    it("stores class and methods", () => {
      indexer.indexFile(rbFixture, "ruby");
      const names = (db.prepare("SELECT name FROM symbols").all() as { name: string }[]).map(
        (r) => r.name
      );
      expect(names).toContain("Greeter");
      expect(names).toContain("greet");
      expect(names).toContain("format_name");
    });

    it("stores the file record with correct language", () => {
      indexer.indexFile(rbFixture, "ruby");
      const file = db.prepare("SELECT language FROM files WHERE path = ?").get(rbFixture) as
        | { language: string }
        | undefined;
      expect(file?.language).toBe("ruby");
    });
  });

  describe("re-indexing", () => {
    it("replaces symbols on second index — no duplicates", () => {
      indexer.indexFile(tsFixture, "typescript");
      indexer.indexFile(tsFixture, "typescript");
      const count = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
      expect(count).toBe(9);
    });
  });

  describe("removeFile", () => {
    it("deletes the file record", () => {
      indexer.indexFile(tsFixture, "typescript");
      indexer.removeFile(tsFixture);
      const file = db.prepare("SELECT * FROM files WHERE path = ?").get(tsFixture);
      expect(file).toBeUndefined();
    });

    it("cascades to symbols", () => {
      indexer.indexFile(tsFixture, "typescript");
      indexer.removeFile(tsFixture);
      const symbols = db
        .prepare("SELECT * FROM symbols WHERE file_path = ?")
        .all(tsFixture);
      expect(symbols).toHaveLength(0);
    });

    it("cascades to call edges", () => {
      indexer.indexFile(tsFixture, "typescript");
      indexer.removeFile(tsFixture);
      const edges = db.prepare("SELECT * FROM call_edges").all();
      expect(edges).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("does not throw on a missing file", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => indexer.indexFile("/nonexistent/file.ts", "typescript")).not.toThrow();
      vi.restoreAllMocks();
    });

    it("leaves the DB unchanged after a parse error", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      indexer.indexFile("/nonexistent/file.ts", "typescript");
      vi.restoreAllMocks();
      const count = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
      expect(count).toBe(0);
    });
  });
});
