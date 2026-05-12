/**
 * Discourse indexing benchmark — sequential (indexFile) vs bulkIndex.
 *
 * Run from the monorepo root after building:
 *   node packages/core/bench-discourse.mjs
 */

import { execSync } from "node:child_process";
import { cpus } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import from built dist so workers can resolve parser-worker.js correctly.
const { openDb, Indexer } = await import(join(__dirname, "dist/index.js"));

const DISCOURSE = "/home/dobby/projects/discourse";
const SEQ_LIMIT = 500; // cap sequential to avoid multi-minute resolution passes

// ── Collect files ────────────────────────────────────────────────────────────

const allFiles = execSync(
  `find ${DISCOURSE} -type f -name "*.rb" | grep -v /vendor/ | sort`,
  { encoding: "utf8" }
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((path) => ({ path, language: "ruby" }));

console.log(`Discourse: ${allFiles.length} Ruby files  |  ${cpus().length} CPUs\n`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function counts(db) {
  const f = db.prepare("SELECT COUNT(*) as c FROM files").get().c;
  const s = db.prepare("SELECT COUNT(*) as c FROM symbols").get().c;
  return `${f.toLocaleString()} files, ${s.toLocaleString()} symbols`;
}

// ── 1. Sequential: indexFile per file (old behaviour) ────────────────────────

console.log(`--- Sequential (indexFile × ${SEQ_LIMIT} files) ---`);
{
  const db = openDb(":memory:");
  const indexer = new Indexer(db);
  const files = allFiles.slice(0, SEQ_LIMIT);

  const t0 = Date.now();
  for (const { path, language } of files) {
    indexer.indexFile(path, language);
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  ${counts(db)}  in ${elapsed.toFixed(1)}s`);
  console.log(`  (${((elapsed / SEQ_LIMIT) * 1000).toFixed(0)} ms/file avg)`);
  db.close();
}

// ── 2. bulkIndex: parallel workers, one transaction, one resolution pass ─────

console.log(`\n--- bulkIndex (${allFiles.length} files, ${cpus().length} workers) ---`);
{
  const db = openDb(":memory:");
  const indexer = new Indexer(db);

  const t0 = Date.now();
  await indexer.bulkIndex(allFiles);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  ${counts(db)}  in ${elapsed.toFixed(1)}s`);
  console.log(`  (${((elapsed / allFiles.length) * 1000).toFixed(0)} ms/file avg)`);
  db.close();
}

// ── 3. bulkIndex on same 500-file subset for apples-to-apples comparison ─────

console.log(`\n--- bulkIndex (${SEQ_LIMIT} files, same subset as sequential) ---`);
{
  const db = openDb(":memory:");
  const indexer = new Indexer(db);
  const files = allFiles.slice(0, SEQ_LIMIT);

  const t0 = Date.now();
  await indexer.bulkIndex(files);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`  ${counts(db)}  in ${elapsed.toFixed(1)}s`);

  const seqTime = parseFloat(process.__seqTime ?? "0");
  console.log(`  (${((elapsed / SEQ_LIMIT) * 1000).toFixed(0)} ms/file avg)`);
  db.close();
}
