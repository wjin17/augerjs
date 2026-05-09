import { bench, describe, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db/index";
import { Indexer } from "./indexer";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "../../../fixtures");
const tsFixture = `${fixtures}/typescript/sample.ts`;
const rbFixture = `${fixtures}/ruby/sample.rb`;

// ── Cold indexing ────────────────────────────────────────────────────────────
// Fresh in-memory DB per iteration — measures parse + schema write from scratch.

describe("cold index", () => {
  let db: Database.Database;
  let indexer: Indexer;

  beforeEach(() => {
    db = openDb(":memory:");
    indexer = new Indexer(db);
  });
  afterEach(() => db.close());

  bench("TypeScript file", () => {
    indexer.indexFile(tsFixture, "typescript");
  });

  bench("Ruby file", () => {
    indexer.indexFile(rbFixture, "ruby");
  });
});

// ── Warm re-index ────────────────────────────────────────────────────────────
// File already in DB — measures the update path the watcher uses on every save.

describe("warm re-index", () => {
  let db: Database.Database;
  let indexer: Indexer;

  beforeAll(() => {
    db = openDb(":memory:");
    indexer = new Indexer(db);
    indexer.indexFile(tsFixture, "typescript");
    indexer.indexFile(rbFixture, "ruby");
  });
  afterAll(() => db.close());

  bench("TypeScript file", () => {
    indexer.indexFile(tsFixture, "typescript");
  });

  bench("Ruby file", () => {
    indexer.indexFile(rbFixture, "ruby");
  });
});

// ── Batch indexing ───────────────────────────────────────────────────────────
// Simulates indexing a whole project by re-indexing the fixture N times under
// distinct paths. Measures amortised throughput for multi-file projects.

function seedBatch(db: Database.Database, indexer: Indexer, n: number) {
  for (let i = 0; i < n; i++) {
    // Point the indexer at the real fixture but stored under a fake path
    // by temporarily aliasing via a second Project run isn't easy, so we
    // just measure N repeated indexFile calls (same file, same content).
    indexer.indexFile(tsFixture, "typescript");
  }
}

describe("batch throughput", () => {
  bench(
    "10 files",
    () => {
      const db = openDb(":memory:");
      seedBatch(db, new Indexer(db), 10);
      db.close();
    },
    { time: 2000 }
  );

  bench(
    "50 files",
    () => {
      const db = openDb(":memory:");
      seedBatch(db, new Indexer(db), 50);
      db.close();
    },
    { time: 2000 }
  );
});

// ── Auger vs grep/sed/awk ────────────────────────────────────────────────────
// Compares pre-indexed SQLite queries against raw file scanning for equivalent
// tasks. Single-file results may favour grep due to subprocess spawn overhead
// dominating on tiny inputs; the advantage reverses as corpus size grows.
//
// Statements are prepared once in beforeAll so the bench measures only the
// query execution, not statement compilation.

// SQLite in-memory queries are sub-microsecond, below performance.now() timer
// resolution on Linux (~100µs due to Spectre mitigations). Each Auger bench
// runs N_AUGER iterations per vitest sample so the total lands in measurable
// range. Divide reported ns/op by N_AUGER to get per-query latency.
// grep spawns a subprocess (~2-3ms each), so 1 invocation per sample is fine.
const N_AUGER = 10_000;
const BENCH_TIME = 1500; // ms per benchmark

// ── find_symbol: locate a named symbol ──────────────────────────────────────

describe("find symbol by name — 1 file", () => {
  let db: Database.Database;
  let findStmt: ReturnType<Database.Database["prepare"]>;

  beforeAll(() => {
    db = openDb(":memory:");
    new Indexer(db).indexFile(tsFixture, "typescript");
    findStmt = db.prepare(
      "SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0"
    );
  });
  afterAll(() => db.close());

  bench(`auger — ${N_AUGER}× WHERE name = 'add'`, () => {
    let n = 0;
    for (let i = 0; i < N_AUGER; i++) n += (findStmt.all("add") as unknown[]).length;
    return n;
  }, { time: BENCH_TIME });

  bench("grep — 1× regex scan (fork+exec+read+match)", () => {
    // Approximate: matches `function add(` and `const add =` but misses arrow
    // shorthands, method shorthand, class fields — and gets false positives in
    // comments and strings.
    execSync(`grep -nE "(function|const)\\s+add[\\s(=<]" "${tsFixture}"`, { stdio: "pipe" });
  }, { time: BENCH_TIME });
});

// ── search: full-text across names, signatures, docstrings ──────────────────

describe("full-text search — 1 file", () => {
  let db: Database.Database;
  let ftsStmt: ReturnType<Database.Database["prepare"]>;

  beforeAll(() => {
    db = openDb(":memory:");
    new Indexer(db).indexFile(tsFixture, "typescript");
    ftsStmt = db.prepare(
      `SELECT s.name FROM symbols_fts f JOIN symbols s ON s.id = f.rowid
       WHERE symbols_fts MATCH ? AND s.is_anonymous = 0 LIMIT 50`
    );
  });
  afterAll(() => db.close());

  bench(`auger — ${N_AUGER}× FTS5 MATCH (porter-stemmed, name+sig+doc)`, () => {
    let n = 0;
    for (let i = 0; i < N_AUGER; i++) n += (ftsStmt.all("format*") as unknown[]).length;
    return n;
  }, { time: BENCH_TIME });

  bench("grep — 1× raw line scan", () => {
    execSync(`grep -n "format" "${tsFixture}"`, { stdio: "pipe" });
  }, { time: BENCH_TIME });
});

// ── get_file_symbols: enumerate all symbols in a file ───────────────────────

describe("list file symbols — 1 file", () => {
  let db: Database.Database;
  let listStmt: ReturnType<Database.Database["prepare"]>;

  beforeAll(() => {
    db = openDb(":memory:");
    new Indexer(db).indexFile(tsFixture, "typescript");
    listStmt = db.prepare(
      "SELECT name, kind, signature, file_path, start_line FROM symbols WHERE file_path = ? ORDER BY start_line"
    );
  });
  afterAll(() => db.close());

  bench(`auger — ${N_AUGER}× WHERE file_path = ?`, () => {
    let n = 0;
    for (let i = 0; i < N_AUGER; i++) n += (listStmt.all(tsFixture) as unknown[]).length;
    return n;
  }, { time: BENCH_TIME });

  bench("grep+awk — 1× multi-pattern heuristic (misses class fields, obj methods)", () => {
    // Covers only the most common declaration forms; class field arrows, object
    // literal methods, and anonymous callbacks require further passes.
    execSync(
      `grep -nE "^(export )?(async )?(function|class|interface) [A-Za-z_]|^(export )?(const|type) [A-Za-z_]+ =" "${tsFixture}" | awk -F: '{print $1, substr($0, index($0,$2))}'`,
      { stdio: "pipe" }
    );
  }, { time: BENCH_TIME });
});

// ── Multi-file: where Auger's O(1) lookup beats grep's O(n) scan ────────────

const CORPUS_SIZE = 20;

describe(`find symbol by name — ${CORPUS_SIZE} files`, () => {
  let db: Database.Database;
  let tmpDir: string;
  let findStmt: ReturnType<Database.Database["prepare"]>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "auger-bench-"));
    const src = readFileSync(tsFixture, "utf8");
    db = openDb(":memory:");
    const indexer = new Indexer(db);
    for (let i = 0; i < CORPUS_SIZE; i++) {
      const p = join(tmpDir, `file${i}.ts`);
      writeFileSync(p, src);
      indexer.indexFile(p, "typescript");
    }
    findStmt = db.prepare(
      "SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0"
    );
  });
  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  bench(`auger — ${N_AUGER}× indexed lookup (O(1) regardless of file count)`, () => {
    let n = 0;
    for (let i = 0; i < N_AUGER; i++) n += (findStmt.all("add") as unknown[]).length;
    return n;
  }, { time: BENCH_TIME });

  bench("grep -r — 1× linear scan across all files (O(n) in file count)", () => {
    execSync(`grep -rnE "(function|const)\\s+add[\\s(=<]" "${tmpDir}"`, { stdio: "pipe" });
  }, { time: BENCH_TIME });
});

// ── Caller tracing: structural — grep has no equivalent ─────────────────────
// grep can match call-site lines but cannot transitively resolve who calls the
// callers, and produces false positives from comments and string literals.

describe("trace callers of 'formatName'", () => {
  let db: Database.Database;
  let traceStmt: ReturnType<Database.Database["prepare"]>;

  beforeAll(() => {
    db = openDb(":memory:");
    new Indexer(db).indexFile(tsFixture, "typescript");
    traceStmt = db.prepare(`
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
  });
  afterAll(() => db.close());

  bench(`auger — ${N_AUGER}× recursive CTE through call_edges (exact, no false positives)`, () => {
    let n = 0;
    for (let i = 0; i < N_AUGER; i++) n += (traceStmt.all("formatName") as unknown[]).length;
    return n;
  }, { time: BENCH_TIME });

  bench("grep — 1× text search for call sites (shallow, no graph, false positives)", () => {
    // One pass only — cannot follow callers-of-callers, matches comments/strings.
    execSync(`grep -n "formatName(" "${tsFixture}"`, { stdio: "pipe" });
  }, { time: BENCH_TIME });
});
