import type { FSWatcher } from "chokidar";
import type Database from "better-sqlite3";
import { openDb } from "./db/index.js";
import { Indexer } from "./indexer.js";
import { startWatcher } from "./watcher.js";
import { findProjectRoot, dbPathForRoot } from "./project.js";
import { resolveManifest } from "./manifest.js";
import { dirname } from "node:path";

interface ProjectContext {
  db: Database.Database;
  watcher: FSWatcher;
  ready: Promise<void>;
  isReady: boolean;
}

export class ProjectRegistry {
  private projects = new Map<string, ProjectContext>();

  constructor(readonly startupRoot: string) {}

  // Returns a ready DB for the project containing the given path (or the
  // startup project when root is undefined). Opens and indexes the project
  // on first access; subsequent calls return the cached DB immediately.
  async getDb(root?: string): Promise<Database.Database> {
    const projectRoot = root ? findProjectRoot(root) : this.startupRoot;

    if (!this.projects.has(projectRoot)) {
      // Synchronous setup — map entry is set before any await so concurrent
      // calls for the same root won't double-open.
      this.openProject(projectRoot);
    }

    const ctx = this.projects.get(projectRoot)!;
    await ctx.ready;
    return ctx.db;
  }

  // Derive project root from any file/directory path within the project.
  rootForPath(anyPath: string): string {
    const dir = anyPath.endsWith("/") ? anyPath : dirname(anyPath);
    return findProjectRoot(dir);
  }

  async reindexProject(root?: string): Promise<void> {
    const projectRoot = root ? findProjectRoot(root) : this.startupRoot;
    this.closeProject(projectRoot);
    await this.getDb(projectRoot);
  }

  closeProject(root: string) {
    const ctx = this.projects.get(root);
    if (!ctx) return;
    ctx.watcher.close();
    ctx.db.close();
    this.projects.delete(root);
  }

  close() {
    for (const ctx of this.projects.values()) {
      ctx.watcher.close();
      ctx.db.close();
    }
    this.projects.clear();
  }

  getStatus(root?: string): { db: Database.Database; isReady: boolean } | null {
    const projectRoot = root ? findProjectRoot(root) : this.startupRoot;
    const ctx = this.projects.get(projectRoot);
    if (!ctx) return null;
    return { db: ctx.db, isReady: ctx.isReady };
  }

  private openProject(rootDir: string) {
    const manifest = resolveManifest(rootDir);
    const db = openDb(dbPathForRoot(rootDir));
    const indexer = new Indexer(db);
    const { watcher, ready } = startWatcher(manifest, rootDir, db, indexer);
    const ctx: ProjectContext = { db, watcher, ready, isReady: false };
    this.projects.set(rootDir, ctx);
    ready.then(() => { ctx.isReady = true; });
  }
}
