import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      const emitter = new EventEmitter() as any;
      emitter.close = vi.fn();
      return emitter;
    }),
  },
}));

import { startWatcher } from "./watcher.js";
import { openDb } from "./db/index.js";
import { Indexer } from "./indexer.js";
import { defaultManifest } from "./manifest.js";
import chokidar from "chokidar";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, "../../../fixtures");
const tsRelPath = "typescript/sample.ts";
const tsFixture = resolve(fixtures, tsRelPath);

describe("startWatcher", () => {
  let db: Database.Database;
  let indexer: Indexer;

  beforeEach(() => {
    db = openDb(":memory:");
    indexer = new Indexer(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  function spawnWatcher() {
    startWatcher(defaultManifest(fixtures), fixtures, db, indexer);
    return vi.mocked(chokidar.watch).mock.results.at(-1)!.value;
  }

  describe("add / change handler", () => {
    it("indexes a new file when add fires", () => {
      const spy = vi.spyOn(indexer, "indexFile");
      const watcher = spawnWatcher();

      watcher.emit("add", tsRelPath);

      expect(spy).toHaveBeenCalledWith(tsFixture, "typescript");
    });

    it("skips re-indexing when the file mtime predates indexed_at", () => {
      indexer.indexFile(tsFixture, "typescript");
      // Push indexed_at far into the future so mtime < indexed_at is always true.
      db.prepare("UPDATE files SET indexed_at = ? WHERE path = ?").run(
        Date.now() + 1_000_000,
        tsFixture
      );

      const spy = vi.spyOn(indexer, "indexFile");
      const watcher = spawnWatcher();

      watcher.emit("add", tsRelPath);

      expect(spy).not.toHaveBeenCalled();
    });

    it("skips re-indexing when hash matches even if mtime fast-path is bypassed", () => {
      indexer.indexFile(tsFixture, "typescript");
      // Set indexed_at to 0 so the mtime fast-path never fires; the hash check must handle it.
      db.prepare("UPDATE files SET indexed_at = 0 WHERE path = ?").run(tsFixture);

      const spy = vi.spyOn(indexer, "indexFile");
      const watcher = spawnWatcher();

      watcher.emit("add", tsRelPath);

      expect(spy).not.toHaveBeenCalled();
    });

    it("re-indexes when hash has changed", () => {
      indexer.indexFile(tsFixture, "typescript");
      // Stale hash + indexed_at=0 so both fast-paths fail and re-index runs.
      db.prepare("UPDATE files SET hash = 'deadbeef', indexed_at = 0 WHERE path = ?").run(
        tsFixture
      );

      const spy = vi.spyOn(indexer, "indexFile");
      const watcher = spawnWatcher();

      watcher.emit("change", tsRelPath);

      expect(spy).toHaveBeenCalledWith(tsFixture, "typescript");
    });

    it("ignores files with unsupported extensions", () => {
      const spy = vi.spyOn(indexer, "indexFile");
      const watcher = spawnWatcher();

      watcher.emit("add", "some/file.json");

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("unlink handler", () => {
    it("calls removeFile when unlink fires", () => {
      const spy = vi.spyOn(indexer, "removeFile");
      const watcher = spawnWatcher();

      watcher.emit("unlink", tsRelPath);

      expect(spy).toHaveBeenCalledWith(tsFixture);
    });
  });
});
