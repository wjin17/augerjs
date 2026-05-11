import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bump this whenever the schema changes incompatibly.
// openDb will wipe and recreate any on-disk DB whose version doesn't match.
const SCHEMA_VERSION = 1;

function wipeDb(dbPath: string, reason: string) {
  process.stderr.write(`auger: ${reason}, rebuilding index…\n`);
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbPath + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

export function openDb(dbPath: string): Database.Database {
  const isNew = dbPath === ":memory:" || !existsSync(dbPath);

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  } catch (err) {
    if (!isNew && dbPath !== ":memory:") {
      try { (db! as Database.Database).close(); } catch {}
      wipeDb(dbPath, "corrupt database");
      return openDb(dbPath);
    }
    throw err;
  }

  if (!isNew) {
    let stored: number;
    try {
      stored = db.pragma("user_version", { simple: true }) as number;
    } catch {
      db.close();
      wipeDb(dbPath, "corrupt database");
      return openDb(dbPath);
    }
    if (stored !== SCHEMA_VERSION) {
      db.close();
      wipeDb(dbPath, `schema version mismatch (${stored} → ${SCHEMA_VERSION})`);
      return openDb(dbPath);
    }
  }

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  if (dbPath !== ":memory:") {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}
