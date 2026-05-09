import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@augerjs/core";
import { Indexer } from "@augerjs/core";
import { handleTool } from "./index";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "../../../fixtures");

describe("MCP tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    const indexer = new Indexer(db);
    indexer.indexFile(`${fixtures}/typescript/sample.ts`, "typescript");
  });

  afterEach(() => {
    db.close();
  });

  describe("find_symbol", () => {
    it("returns matches for a known symbol", () => {
      const result = handleTool(db, "find_symbol", { name: "add" }) as any;
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].name).toBe("add");
      expect(result.matches[0].kind).toBe("function");
    });

    it("includes a location field", () => {
      const result = handleTool(db, "find_symbol", { name: "add" }) as any;
      expect(result.matches[0].location).toMatch(/sample\.ts:\d+/);
    });

    it("returns empty matches for an unknown symbol", () => {
      const result = handleTool(db, "find_symbol", { name: "doesNotExist" }) as any;
      expect(result.matches).toHaveLength(0);
    });

    it("does not return anonymous symbols", () => {
      const result = handleTool(db, "find_symbol", { name: "<anonymous:46>" }) as any;
      expect(result.matches).toHaveLength(0);
    });
  });

  describe("get_symbol", () => {
    it("returns the full record for a known symbol", () => {
      const result = handleTool(db, "get_symbol", { name: "greet" }) as any;
      expect(result.name).toBe("greet");
      expect(result.kind).toBe("method");
      expect(result.signature).toContain("greet");
      expect(result.location).toMatch(/sample\.ts:\d+/);
    });

    it("includes callers and callees", () => {
      const result = handleTool(db, "get_symbol", { name: "greet" }) as any;
      expect(Array.isArray(result.callers)).toBe(true);
      expect(Array.isArray(result.callees)).toBe(true);
      expect(result.callees.some((c: any) => c.name === "formatName")).toBe(true);
    });

    it("callers and callees include location fields", () => {
      const result = handleTool(db, "get_symbol", { name: "greet" }) as any;
      for (const callee of result.callees) {
        expect(callee.location).toMatch(/:\d+$/);
      }
    });

    it("returns found: false for an unknown symbol", () => {
      const result = handleTool(db, "get_symbol", { name: "doesNotExist" }) as any;
      expect(result.found).toBe(false);
    });

    it("does not return anonymous symbols", () => {
      const result = handleTool(db, "get_symbol", { name: "<anonymous:46>" }) as any;
      expect(result.found).toBe(false);
    });

    it("returns flat record for a unique name", () => {
      const result = handleTool(db, "get_symbol", { name: "add" }) as any;
      expect(result.name).toBe("add");
      expect(result.matches).toBeUndefined();
    });

    it("returns matches array when multiple files define the same name", () => {
      // Seed a second file with a duplicate symbol name
      db.prepare(
        "INSERT INTO files (path, language, hash, indexed_at) VALUES (?, 'typescript', 'abc', datetime('now'))"
      ).run("/other/file.ts");
      db.prepare(
        "INSERT INTO symbols (name, kind, file_path, start_line, end_line, signature) VALUES (?, 'function', '/other/file.ts', 1, 5, 'function add(...)')"
      ).run("add");
      const result = handleTool(db, "get_symbol", { name: "add" }) as any;
      expect(Array.isArray(result.matches)).toBe(true);
      expect(result.matches).toHaveLength(2);
      expect(result.matches.every((m: any) => m.name === "add")).toBe(true);
    });
  });

  describe("trace_callers", () => {
    it("finds what calls formatName", () => {
      const result = handleTool(db, "trace_callers", { name: "formatName" }) as any;
      const names = result.trace.map((r: any) => r.name);
      expect(names).toContain("greet");
    });

    it("includes location on trace nodes", () => {
      const result = handleTool(db, "trace_callers", { name: "formatName" }) as any;
      for (const node of result.trace) {
        expect(node.location).toMatch(/:\d+$/);
      }
    });

    it("returns empty trace for a symbol with no callers", () => {
      const result = handleTool(db, "trace_callers", { name: "add" }) as any;
      expect(result.trace).toHaveLength(0);
    });
  });

  describe("trace_callees", () => {
    it("finds what greet calls", () => {
      const result = handleTool(db, "trace_callees", { name: "greet" }) as any;
      const names = result.trace.map((r: any) => r.name);
      expect(names).toContain("formatName");
    });

    it("respects max_depth", () => {
      const result = handleTool(db, "trace_callees", { name: "greet", max_depth: 1 }) as any;
      for (const node of result.trace) {
        expect(node.depth).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("search", () => {
    it("finds symbols by name", () => {
      const result = handleTool(db, "search", { query: "add" }) as any;
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain("add");
    });

    it("includes location on results", () => {
      const result = handleTool(db, "search", { query: "add" }) as any;
      for (const r of result.results) {
        expect(r.location).toMatch(/:\d+$/);
      }
    });

    it("returns empty results for an unindexed term", () => {
      const result = handleTool(db, "search", { query: "zzznomatch" }) as any;
      expect(result.results).toHaveLength(0);
    });

    it("does not return anonymous symbols", () => {
      const result = handleTool(db, "search", { query: "anonymous" }) as any;
      expect(result.results).toHaveLength(0);
    });
  });

  describe("get_file_symbols", () => {
    it("returns all symbols for a file", () => {
      const result = handleTool(db, "get_file_symbols", {
        path: `${fixtures}/typescript/sample.ts`,
      }) as any;
      const names = result.symbols.map((s: any) => s.name).sort();
      const namedNames = names.filter((n: string) => !n.startsWith("<anonymous"));
      expect(namedNames).toEqual([
        "Greeter", "User", "UserId", "add", "double", "formatName", "get",
        "greet", "greetAsync", "identity", "onClick", "post", "processItems", "routes",
      ]);
      expect(names.filter((n: string) => n.startsWith("<anonymous")).length).toBeGreaterThan(0);
    });

    it("includes location on each symbol", () => {
      const result = handleTool(db, "get_file_symbols", {
        path: `${fixtures}/typescript/sample.ts`,
      }) as any;
      for (const s of result.symbols) {
        expect(s.location).toMatch(/sample\.ts:\d+/);
      }
    });

    it("returns empty for an unindexed path", () => {
      const result = handleTool(db, "get_file_symbols", { path: "/not/indexed.ts" }) as any;
      expect(result.symbols).toHaveLength(0);
    });
  });

  describe("unknown tool", () => {
    it("throws for an unrecognised tool name", () => {
      expect(() => handleTool(db, "explode", {})).toThrow("Unknown tool: explode");
    });
  });
});
