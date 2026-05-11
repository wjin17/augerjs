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
    it("stores all named symbols", () => {
      indexer.indexFile(tsFixture, "typescript");
      const names = (
        db.prepare("SELECT name FROM symbols WHERE is_anonymous = 0").all() as { name: string }[]
      )
        .map((r) => r.name)
        .sort();
      expect(names).toEqual([
        "Direction",
        "Down",
        "Greeter",
        "Left",
        "Right",
        "Up",
        "User",
        "UserId",
        "add",
        "double",
        "formatName",
        "get",
        "greet",
        "greetAsync",
        "identity",
        "onClick",
        "post",
        "processItems",
        "routes",
      ]);
    });

    it("stores anonymous callback symbols", () => {
      indexer.indexFile(tsFixture, "typescript");
      const anons = (
        db.prepare("SELECT name FROM symbols WHERE is_anonymous = 1").all() as { name: string }[]
      ).map((r) => r.name);
      expect(anons.length).toBeGreaterThan(0);
      for (const name of anons) {
        expect(name).toMatch(/^<anonymous:\d+/);
      }
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
      const rows = db.prepare("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'add'").all();
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("indexFile — Ruby", () => {
    it("stores class and methods", () => {
      indexer.indexFile(rbFixture, "ruby");
      const names = (db.prepare("SELECT name FROM symbols").all() as { name: string }[]).map(
        (r) => r.name
      );
      expect(names).toContain("Person");
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
      const named = (
        db.prepare("SELECT COUNT(*) as c FROM symbols WHERE is_anonymous = 0").get() as {
          c: number;
        }
      ).c;
      expect(named).toBe(19);
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
      const symbols = db.prepare("SELECT * FROM symbols WHERE file_path = ?").all(tsFixture);
      expect(symbols).toHaveLength(0);
    });

    it("cascades to call edges", () => {
      indexer.indexFile(tsFixture, "typescript");
      indexer.removeFile(tsFixture);
      const edges = db.prepare("SELECT * FROM call_edges").all();
      expect(edges).toHaveLength(0);
    });
  });

  describe("cross-file resolution", () => {
    const utilsFixture = `${fixtures}/cross-file/utils.ts`;
    const mainFixture = `${fixtures}/cross-file/main.ts`;

    it("stores imports for a file with named imports", () => {
      indexer.indexFile(utilsFixture, "typescript");
      indexer.indexFile(mainFixture, "typescript");
      const rows = db
        .prepare("SELECT local_name, exported_name FROM imports WHERE file_path = ?")
        .all(mainFixture) as { local_name: string; exported_name: string }[];
      expect(rows).toContainEqual({ local_name: "formatDate", exported_name: "formatDate" });
      expect(rows).toContainEqual({ local_name: "pd", exported_name: "parseDate" });
    });

    it("resolves callee_id across files via named imports", () => {
      indexer.indexFile(utilsFixture, "typescript");
      indexer.indexFile(mainFixture, "typescript");
      const formatDateSym = db
        .prepare("SELECT id FROM symbols WHERE name = 'formatDate'")
        .get() as { id: number };
      const edge = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'formatDate'")
        .get() as { callee_id: number | null } | undefined;
      expect(edge?.callee_id).toBe(formatDateSym.id);
    });

    it("resolves aliased import callee_id via exported_name", () => {
      indexer.indexFile(utilsFixture, "typescript");
      indexer.indexFile(mainFixture, "typescript");
      const parseDateSym = db.prepare("SELECT id FROM symbols WHERE name = 'parseDate'").get() as {
        id: number;
      };
      const edge = db.prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'pd'").get() as
        | { callee_id: number | null }
        | undefined;
      expect(edge?.callee_id).toBe(parseDateSym.id);
    });

    it("resolves edges retroactively when callee file is indexed after caller", () => {
      indexer.indexFile(mainFixture, "typescript");
      const before = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'formatDate'")
        .get() as { callee_id: number | null } | undefined;
      expect(before?.callee_id).toBeNull();

      indexer.indexFile(utilsFixture, "typescript");
      const after = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'formatDate'")
        .get() as { callee_id: number | null } | undefined;
      expect(after?.callee_id).not.toBeNull();
    });

    it("cleans up imports on re-index", () => {
      indexer.indexFile(utilsFixture, "typescript");
      indexer.indexFile(mainFixture, "typescript");
      indexer.indexFile(mainFixture, "typescript");
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM imports WHERE file_path = ?").get(mainFixture) as {
          c: number;
        }
      ).c;
      expect(count).toBe(2);
    });
  });

  describe("cross-file resolution — Ruby", () => {
    const formatterFixture = `${fixtures}/ruby/formatter.rb`;
    const personFixture = `${fixtures}/ruby/person.rb`;
    const autoloadedFixture = `${fixtures}/ruby/autoloaded.rb`;

    it("stores wildcard import for require_relative", () => {
      indexer.indexFile(formatterFixture, "ruby");
      indexer.indexFile(personFixture, "ruby");
      const row = db
        .prepare("SELECT exported_name, source_path FROM imports WHERE file_path = ?")
        .get(personFixture) as { exported_name: string; source_path: string } | undefined;
      expect(row?.exported_name).toBe("*");
      expect(row?.source_path).toBe(formatterFixture);
    });

    it("resolves cross-file callee via require_relative", () => {
      indexer.indexFile(formatterFixture, "ruby");
      indexer.indexFile(personFixture, "ruby");
      const titleizeSym = db
        .prepare("SELECT id FROM symbols WHERE name = 'titleize'")
        .get() as { id: number };
      const edge = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'titleize'")
        .get() as { callee_id: number | null } | undefined;
      expect(edge?.callee_id).toBe(titleizeSym.id);
    });

    it("resolves retroactively when callee file is indexed after caller", () => {
      indexer.indexFile(personFixture, "ruby");
      const before = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'titleize'")
        .get() as { callee_id: number | null } | undefined;
      expect(before?.callee_id).toBeNull();

      indexer.indexFile(formatterFixture, "ruby");
      const after = db
        .prepare("SELECT callee_id FROM call_edges WHERE callee_name = 'titleize'")
        .get() as { callee_id: number | null } | undefined;
      expect(after?.callee_id).not.toBeNull();
    });

    it("resolves callee via global Ruby fallback (Rails autoloading, no require)", () => {
      indexer.indexFile(formatterFixture, "ruby");
      indexer.indexFile(autoloadedFixture, "ruby");
      const titleizeSym = db
        .prepare("SELECT id FROM symbols WHERE name = 'titleize'")
        .get() as { id: number };
      const edge = db
        .prepare(
          "SELECT callee_id FROM call_edges WHERE callee_name = 'titleize' AND caller_id IN (SELECT id FROM symbols WHERE file_path = ?)"
        )
        .get(autoloadedFixture) as { callee_id: number | null } | undefined;
      expect(edge?.callee_id).toBe(titleizeSym.id);
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
