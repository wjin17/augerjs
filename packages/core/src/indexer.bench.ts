import { bench, describe, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
