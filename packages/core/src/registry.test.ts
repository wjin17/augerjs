import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      const emitter = new EventEmitter() as any;
      emitter.close = vi.fn();
      setImmediate(() => emitter.emit("ready"));
      return emitter;
    }),
  },
}));

import { ProjectRegistry } from "./registry.js";
import chokidar from "chokidar";

describe("ProjectRegistry", () => {
  let tmpRoot: string;
  let registry: ProjectRegistry;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "auger-reg-"));
    vi.clearAllMocks();
    registry = new ProjectRegistry(tmpRoot);
  });

  afterEach(() => {
    registry.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("closeProject", () => {
    it("is a no-op for an unknown root", () => {
      expect(() => registry.closeProject("/nonexistent/path")).not.toThrow();
    });

    it("closes the watcher and DB for the given root", async () => {
      const db = await registry.getDb();
      const watcher = vi.mocked(chokidar.watch).mock.results[0].value;

      registry.closeProject(tmpRoot);

      expect(watcher.close).toHaveBeenCalledOnce();
      expect(() => db.prepare("SELECT 1").get()).toThrow();
    });

    it("removes the project so a subsequent getDb re-opens it", async () => {
      await registry.getDb();
      registry.closeProject(tmpRoot);

      const db2 = await registry.getDb();
      expect(() => db2.prepare("SELECT 1").get()).not.toThrow();
    });

    it("does not affect other projects still tracked", async () => {
      const db = await registry.getDb();
      registry.closeProject("/some/unrelated/path");
      expect(() => db.prepare("SELECT 1").get()).not.toThrow();
    });

    it("is safe to call twice on the same root", async () => {
      await registry.getDb();
      registry.closeProject(tmpRoot);
      expect(() => registry.closeProject(tmpRoot)).not.toThrow();
    });
  });

  describe("close", () => {
    it("is safe after closeProject has already removed some projects", async () => {
      await registry.getDb();
      registry.closeProject(tmpRoot);
      expect(() => registry.close()).not.toThrow();
    });
  });
});
