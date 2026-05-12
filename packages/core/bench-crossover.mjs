import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { openDb, Indexer } = await import(join(__dirname, "dist/index.js"));

const rubyFile = (i) => `
class Widget${i}
  attr_reader :name, :value
  def initialize(name, value)
    @name = name
    @value = value
  end
  def process
    validate
    transform(@value)
  end
  def validate
    raise ArgumentError unless @name
  end
  def transform(val)
    val.to_s.upcase
  end
end`.trimStart();

const dir = mkdtempSync(join(tmpdir(), "auger-xover-"));

async function bench(n) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const p = join(dir, `w${i}.rb`);
    writeFileSync(p, rubyFile(i));
    files.push({ path: p, language: "ruby" });
  }

  const time = async (fn) => {
    const t = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };

  const run = {
    seq: () => { const db = openDb(":memory:"); const idx = new Indexer(db); for (const f of files) idx.indexFile(f.path, f.language); db.close(); },
    bulk: async () => { const db = openDb(":memory:"); const idx = new Indexer(db); await idx.bulkIndex(files); db.close(); },
  };

  await run.seq(); await run.bulk(); // warm FS cache
  const seq  = await time(run.seq);
  const bulk = await time(run.bulk);

  const winner = seq < bulk ? "seq " : "bulk";
  console.log(`  n=${String(n).padStart(5)}  seq ${String(seq.toFixed(0)).padStart(5)}ms  bulk ${String(bulk.toFixed(0)).padStart(5)}ms  ${winner} wins  (${(seq/bulk).toFixed(2)}×)`);
}

try {
  console.log(`\nCrossover: sequential vs bulkIndex  |  ${cpus().length} CPUs\n`);
  for (const n of [100, 250, 500, 750, 1000, 2000]) {
    await bench(n);
  }
  console.log();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
