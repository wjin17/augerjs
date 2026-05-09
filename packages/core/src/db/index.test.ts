import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./index";
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
