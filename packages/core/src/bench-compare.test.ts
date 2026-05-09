/**
 * Auger vs grep/sed/awk — comparison benchmark.
 *
 * Runs as a vitest test (bun run bench:compare) so it shares the same
 * Node.js runtime as the rest of the project and can load better-sqlite3.
 * Uses process.hrtime.bigint() for nanosecond-resolution timing instead of
 * vitest bench, which loses precision on sub-millisecond operations in WSL2.
 */

import { test, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db/index";
import { Indexer } from "./indexer";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "../../../fixtures");
const tsFixture = `${fixtures}/typescript/sample.ts`;

const AUGER_REPS = 100_000; // per-query repetitions to get stable timing
const GREP_REPS = 200;      // subprocess reps (each ~3ms)
const CORPUS_SIZE = 20;

function ns(bigint: bigint): number { return Number(bigint); }

function fmt(nsPerOp: number): string {
  if (nsPerOp < 1_000) return `${nsPerOp.toFixed(0)} ns`;
  if (nsPerOp < 1_000_000) return `${(nsPerOp / 1000).toFixed(1)} µs`;
  return `${(nsPerOp / 1_000_000).toFixed(2)} ms`;
}

function ratio(a: number, b: number): string {
  return `${(b / a).toFixed(0)}×`;
}

function time(fn: () => void, reps: number): number {
  // Warm up
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  return ns(process.hrtime.bigint() - t0) / reps;
}

// ── Shared state ─────────────────────────────────────────────────────────────

let db: Database.Database;
let tmpDir: string;
let tmpFiles: string[];

beforeAll(() => {
  db = openDb(":memory:");
  const indexer = new Indexer(db);
  indexer.indexFile(tsFixture, "typescript");

  tmpDir = mkdtempSync(join(tmpdir(), "auger-bench-"));
  const src = readFileSync(tsFixture, "utf8");
  const multiDb = openDb(":memory:");
  const multiIndexer = new Indexer(multiDb);
  tmpFiles = Array.from({ length: CORPUS_SIZE }, (_, i) => {
    const p = join(tmpDir, `file${i}.ts`);
    writeFileSync(p, src);
    multiIndexer.indexFile(p, "typescript");
    return p;
  });
  // store multi-file db on db for the multi-file test
  (db as any).__multi = multiDb;
});

afterAll(() => {
  (db as any).__multi?.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test("find_symbol by name — 1 file", () => {
  const stmt = db.prepare(
    "SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0"
  );

  const augerNs = time(() => { stmt.all("add"); }, AUGER_REPS);
  const grepNs  = time(() => {
    execSync(`grep -nE "(function|const)\\s+add[\\s(=<]" "${tsFixture}"`, { stdio: "pipe" });
  }, GREP_REPS);

  console.log("\n── find_symbol('add') ─────────────────────────────────────");
  console.log(`  auger (pre-indexed)   ${fmt(augerNs).padStart(10)}`);
  console.log(`  grep  (raw scan)      ${fmt(grepNs).padStart(10)}   (includes fork+exec overhead)`);
  console.log(`  speedup               ${ratio(augerNs, grepNs).padStart(10)}`);
});

test("full-text search — 1 file", () => {
  const stmt = db.prepare(
    `SELECT s.name FROM symbols_fts f JOIN symbols s ON s.id = f.rowid
     WHERE symbols_fts MATCH ? AND s.is_anonymous = 0 LIMIT 50`
  );

  const augerNs = time(() => { stmt.all("format*"); }, AUGER_REPS);
  const grepNs  = time(() => {
    execSync(`grep -n "format" "${tsFixture}"`, { stdio: "pipe" });
  }, GREP_REPS);

  console.log("\n── search('format') ───────────────────────────────────────");
  console.log(`  auger FTS5 (stemmed)  ${fmt(augerNs).padStart(10)}`);
  console.log(`  grep  (raw scan)      ${fmt(grepNs).padStart(10)}   (no stemming, no docstring search)`);
  console.log(`  speedup               ${ratio(augerNs, grepNs).padStart(10)}`);
});

test("list file symbols — 1 file", () => {
  const stmt = db.prepare(
    "SELECT name, kind, signature, file_path, start_line FROM symbols WHERE file_path = ? ORDER BY start_line"
  );

  const augerNs = time(() => { stmt.all(tsFixture); }, AUGER_REPS);
  const grepNs  = time(() => {
    execSync(
      `grep -nE "^(export )?(async )?(function|class|interface) [A-Za-z_]|^(export )?(const|type) [A-Za-z_]+ =" "${tsFixture}" | awk -F: '{print $1, substr($0, index($0,$2))}'`,
      { stdio: "pipe" }
    );
  }, GREP_REPS);

  console.log("\n── get_file_symbols ───────────────────────────────────────");
  console.log(`  auger (pre-indexed)   ${fmt(augerNs).padStart(10)}   (returns class fields + obj methods too)`);
  console.log(`  grep+awk (heuristic)  ${fmt(grepNs).padStart(10)}   (misses class fields, obj methods, anon)`);
  console.log(`  speedup               ${ratio(augerNs, grepNs).padStart(10)}`);
});

test(`find_symbol across ${CORPUS_SIZE} files`, () => {
  const multiDb: Database.Database = (db as any).__multi;
  const stmt = multiDb.prepare(
    "SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0"
  );

  const augerNs = time(() => { stmt.all("add"); }, AUGER_REPS);
  const grepNs  = time(() => {
    execSync(`grep -rnE "(function|const)\\s+add[\\s(=<]" "${tmpDir}"`, { stdio: "pipe" });
  }, GREP_REPS);

  console.log(`\n── find_symbol across ${CORPUS_SIZE} files ───────────────────────────`);
  console.log(`  auger (O(1) index)    ${fmt(augerNs).padStart(10)}`);
  console.log(`  grep  (O(n) scan)     ${fmt(grepNs).padStart(10)}`);
  console.log(`  speedup               ${ratio(augerNs, grepNs).padStart(10)}`);
});

test("trace callers (call graph vs text search)", () => {
  const stmt = db.prepare(`
    WITH RECURSIVE chain(id, name, file_path, start_line, depth) AS (
      SELECT s.id, s.name, s.file_path, s.start_line, 0
      FROM symbols s WHERE s.name = ?
      UNION
      SELECT s.id, s.name, s.file_path, s.start_line, c.depth + 1
      FROM chain c
      JOIN call_edges e ON e.callee_id = c.id
      JOIN symbols s ON s.id = e.caller_id
      WHERE c.depth < 5
    )
    SELECT DISTINCT id, name, file_path, start_line, depth FROM chain WHERE depth > 0
  `);

  const augerNs = time(() => { stmt.all("formatName"); }, AUGER_REPS);
  const grepNs  = time(() => {
    // grep can only find call sites, not traverse the graph transitively
    execSync(`grep -n "formatName(" "${tsFixture}"`, { stdio: "pipe" });
  }, GREP_REPS);

  console.log("\n── trace_callers('formatName') ────────────────────────────");
  console.log(`  auger CTE (exact)     ${fmt(augerNs).padStart(10)}   (transitive, no false positives)`);
  console.log(`  grep  (1 level only)  ${fmt(grepNs).padStart(10)}   (shallow, matches strings/comments too)`);
  console.log(`  speedup               ${ratio(augerNs, grepNs).padStart(10)}`);
});
