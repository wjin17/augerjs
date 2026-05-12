/**
 * Indexing benchmark — sequential vs bulkIndex on a synthetic corpus.
 *
 * Run after building:
 *   node packages/core/bench-index.mjs
 *
 * Measurements are warm-FS-cache (one discarded warm-up run primes the OS
 * page cache). Worker startup cost is included in every bulkIndex iteration
 * since workers are spawned fresh per call.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { openDb, Indexer } = await import(join(__dirname, "dist/index.js"));

// ── Synthetic corpus ─────────────────────────────────────────────────────────

function rubyFile(i) {
  return `
require_relative "widget_base"

class Widget${i}
  attr_reader :name, :value

  def initialize(name, value)
    @name = name
    @value = value
  end

  def process
    validate
    result = transform(@value)
    notify(result)
    result
  end

  def to_s
    "Widget${i}(\#{@name}: \#{@value})"
  end

  private

  def validate
    raise ArgumentError, "name required" unless @name
    raise ArgumentError, "value required" unless @value
  end

  def transform(val)
    val.to_s.strip.upcase
  end

  def notify(result)
    log("processed: \#{result}")
  end

  def log(msg)
    puts "[Widget${i}] \#{msg}"
  end
end
`.trimStart();
}

function tsFile(i) {
  return `
export interface Item${i} {
  id: number;
  name: string;
  value: number;
}

export type ItemId${i} = number;

export function process${i}(item: Item${i}): string {
  const v = validate${i}(item);
  return transform${i}(v);
}

export class ItemService${i} {
  constructor(private readonly id: ItemId${i}) {}

  get(name: string): Item${i} {
    return { id: this.id, name, value: 0 };
  }

  save(item: Item${i}): string {
    return process${i}(item);
  }
}

function validate${i}(item: Item${i}): Item${i} {
  if (!item.id || !item.name) throw new Error("invalid item");
  return item;
}

function transform${i}(item: Item${i}): string {
  return format${i}(item.name, item.value);
}

function format${i}(name: string, value: number): string {
  return \`\${name}:\${value}\`;
}
`.trimStart();
}

// ── Timing harness ───────────────────────────────────────────────────────────

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s.at(-1) };
}

async function measure(fn, { warmup = 1, runs = 5 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return stats(times);
}

function row(label, s, n) {
  const msf = (v) => `${v.toFixed(0)}ms`.padStart(7);
  const mspf = `${(s.med / n).toFixed(1)} ms/file`;
  console.log(
    `  ${label.padEnd(28)} min${msf(s.min)}  med${msf(s.med)}  max${msf(s.max)}  ${mspf}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Crossover point is ~500 files on a 16-CPU machine — below that, worker
// startup cost (~800ms) exceeds the parallelism benefit. Above it, sequential
// degrades super-linearly because the 4 resolution passes scan the growing
// call_edges table after every file. Run bench-crossover.mjs to find the
// crossover for your machine.
const N_RUBY = 500;
const N_TS = 100;
const RUNS = 5;

const dir = mkdtempSync(join(tmpdir(), "auger-bench-"));

try {
  const files = [];

  for (let i = 0; i < N_RUBY; i++) {
    const p = join(dir, `widget_${i}.rb`);
    writeFileSync(p, rubyFile(i));
    files.push({ path: p, language: "ruby" });
  }
  for (let i = 0; i < N_TS; i++) {
    const p = join(dir, `item_${i}.ts`);
    writeFileSync(p, tsFile(i));
    files.push({ path: p, language: "typescript" });
  }

  console.log(
    `\nCorpus: ${N_RUBY} Ruby + ${N_TS} TS = ${files.length} files  |  ${cpus().length} CPUs  |  ${RUNS} runs + 1 warmup\n`
  );

  const seq = await measure(() => {
    const db = openDb(":memory:");
    const indexer = new Indexer(db);
    for (const { path, language } of files) indexer.indexFile(path, language);
    db.close();
  });
  row("sequential (indexFile ×N)", seq, files.length);

  const bulk = await measure(async () => {
    const db = openDb(":memory:");
    const indexer = new Indexer(db);
    await indexer.bulkIndex(files);
    db.close();
  });
  row(`bulkIndex (${cpus().length} workers)`, bulk, files.length);

  console.log(`\n  speedup: ${(seq.med / bulk.med).toFixed(1)}×  (median)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
