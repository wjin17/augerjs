import chokidar, { type FSWatcher } from "chokidar";
import { extname } from "node:path";
import { Indexer } from "./indexer.js";
import type { Manifest } from "./manifest.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export function startWatcher(
  manifest: Manifest,
  rootDir: string,
  db: Database.Database,
  indexer: Indexer
): { watcher: FSWatcher; ready: Promise<{ elapsed: number } | null> } {
  const watcher = chokidar.watch(manifest.include, {
    cwd: rootDir,
    ignored: manifest.exclude,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: manifest.watch?.debounce ?? 300 },
  });

  const langFor = (path: string): "typescript" | "ruby" | null => {
    const ext = extname(path);
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".rb") return "ruby";
    return null;
  };

  const selectFile = db.prepare<[string], { hash: string; indexed_at: number }>(
    "SELECT hash, indexed_at FROM files WHERE path = ?"
  );

  let isReady = false;
  const pending: Array<{ path: string; language: "typescript" | "ruby" }> = [];

  const handle = (path: string) => {
    const lang = langFor(path);
    if (!lang) return;

    const fullPath = `${rootDir}/${path}`;
    try {
      const mtime = statSync(fullPath).mtimeMs;

      const existing = selectFile.get(fullPath) as
        | { hash: string; indexed_at: number }
        | undefined;

      // Fast path: file mtime predates last index — content cannot have changed.
      if (existing && mtime < existing.indexed_at) return;

      const content = readFileSync(fullPath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      if (existing?.hash === hash) return;

      if (!isReady) {
        pending.push({ path: fullPath, language: lang });
        return;
      }

      indexer.indexFile(fullPath, lang);
    } catch (err) {
      console.error(`[auger] failed to index ${fullPath}:`, err);
    }
  };

  const handleUnlink = (path: string) => {
    try {
      indexer.removeFile(`${rootDir}/${path}`);
    } catch (err) {
      console.error(`[auger] failed to remove ${path}:`, err);
    }
  };

  watcher.on("add", handle);
  watcher.on("change", handle);
  watcher.on("unlink", handleUnlink);

  const ready = new Promise<{ elapsed: number } | null>((resolve) => {
    watcher.once("ready", () => {
      isReady = true;

      // Remove DB entries for files deleted while the watcher was offline.
      const tracked = db.prepare("SELECT path FROM files").all() as { path: string }[];
      for (const { path } of tracked) {
        if (!existsSync(path)) {
          try {
            indexer.removeFile(path);
          } catch {
            /* file already gone */
          }
        }
      }

      if (pending.length === 0) {
        resolve(null);
        return;
      }

      indexer.bulkIndex(pending).then(resolve).catch((err) => {
        console.error("[auger] bulk index failed:", err);
        resolve(null);
      });
    });
  });

  return { watcher, ready };
}
