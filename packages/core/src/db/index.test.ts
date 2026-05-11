import { describe, it, expect, afterEach, vi } from "vitest";
import { openDb } from "./index";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

describe("openDb", () => {
  const dbs: Database.Database[] = [];

  const open = () => {
    const db = openDb(":memory:");
    dbs.push(db);
    return db;
  };

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
  });

  it("creates required tables", () => {
    const db = open();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("files");
    expect(tables).toContain("symbols");
    expect(tables).toContain("call_edges");
  });

  it("creates FTS virtual table", () => {
    const db = open();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain("symbols_fts");
  });

  it("enables foreign keys", () => {
    const db = open();
    const [row] = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(row?.foreign_keys).toBe(1);
  });

  it("is idempotent — schema can be applied twice without error", () => {
    const db = open();
    expect(() => {
      db.prepare("SELECT 1 FROM files").all();
      db.prepare("SELECT 1 FROM symbols").all();
    }).not.toThrow();
  });

  it("FTS trigger indexes symbols on insert", () => {
    const db = open();
    db.prepare("INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)").run(
      "/f.ts",
      "typescript",
      "abc",
      Date.now()
    );
    db.prepare(
      "INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("/f.ts", "myFn", "function", "function myFn()", "does a thing", 1, 5);

    const rows = db.prepare("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'myFn'").all();
    expect(rows).toHaveLength(1);
  });

  it("sets user_version on a new on-disk DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "auger-test-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = openDb(dbPath);
      const v = db.pragma("user_version", { simple: true }) as number;
      db.close();
      expect(v).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("wipes and recreates a DB with stale schema version", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), "auger-test-"));
    const dbPath = join(dir, "test.db");
    try {
      // Create a DB with wrong version and some data
      const stale = new BetterSqlite3(dbPath);
      stale.pragma("user_version = 99");
      stale.exec("CREATE TABLE old_table (id INTEGER PRIMARY KEY)");
      stale.close();

      const db = openDb(dbPath);
      const v = db.pragma("user_version", { simple: true }) as number;
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name);
      db.close();

      expect(v).toBe(1);
      expect(tables).not.toContain("old_table");
      expect(tables).toContain("symbols");
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true });
    }
  });

  it("FTS trigger removes symbols on delete", () => {
    const db = open();
    db.prepare("INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)").run(
      "/f.ts",
      "typescript",
      "abc",
      Date.now()
    );
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("/f.ts", "myFn", "function", "function myFn()", null, 1, 5);

    db.prepare("DELETE FROM symbols WHERE id = ?").run(lastInsertRowid);
    const rows = db.prepare("SELECT name FROM symbols_fts WHERE symbols_fts MATCH 'myFn'").all();
    expect(rows).toHaveLength(0);
  });
});
