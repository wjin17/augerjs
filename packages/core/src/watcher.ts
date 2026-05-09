import chokidar, { type FSWatcher } from "chokidar";
import { extname } from "node:path";
import { Indexer } from "./indexer.js";
import type { Manifest } from "./manifest.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export function startWatcher(
  manifest: Manifest,
  rootDir: string,
  db: Database.Database,
  indexer: Indexer
): { watcher: FSWatcher; ready: Promise<void> } {
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

  const handle = (path: string) => {
    const lang = langFor(path);
    if (!lang) return;

    const fullPath = `${rootDir}/${path}`;
    try {
      const content = readFileSync(fullPath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");

      const existing = db
        .prepare("SELECT hash FROM files WHERE path = ?")
        .get(fullPath) as { hash: string } | undefined;

      if (existing?.hash === hash) return;
      indexer.indexFile(fullPath, lang);
    } catch (err) {
      console.error(`[auger] failed to index ${fullPath}:`, err);
    }
  };

  watcher.on("add", handle);
  watcher.on("change", handle);
  watcher.on("unlink", (path) => {
    try {
      indexer.removeFile(`${rootDir}/${path}`);
    } catch (err) {
      console.error(`[auger] failed to remove ${path}:`, err);
    }
  });

  const ready = new Promise<void>((resolve) => watcher.once("ready", resolve));
  return { watcher, ready };
}
