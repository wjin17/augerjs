import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bump this whenever the schema changes incompatibly.
// openDb will wipe and recreate any on-disk DB whose version doesn't match.
const SCHEMA_VERSION = 1;

export function openDb(dbPath: string): Database.Database {
  const isNew = dbPath === ":memory:" || !existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (!isNew) {
    const stored = db.pragma("user_version", { simple: true }) as number;
    if (stored !== SCHEMA_VERSION) {
      db.close();
      process.stderr.write(`auger: schema version mismatch (${stored} → ${SCHEMA_VERSION}), rebuilding index…\n`);
      unlinkSync(dbPath);
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
