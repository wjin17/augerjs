import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Strong markers unambiguously identify a project root.
const STRONG_MARKERS = [".auger.yml", "package.json", "go.mod", "Cargo.toml", "Gemfile", "pyproject.toml", ".git"];
// Weak markers are checked only if no strong marker is found anywhere in the tree —
// they appear too often in subdirectories (e.g. tsconfig.json in src/).
const WEAK_MARKERS = ["tsconfig.json"];

export function findProjectRoot(fromPath: string): string {
  // Accept either a file path or directory.
  let startDir = fromPath;
  if (!fromPath.endsWith("/") && existsSync(fromPath) && !isDir(fromPath)) {
    startDir = dirname(fromPath);
  }

  // First pass: strong markers.
  let dir = startDir;
  while (true) {
    for (const marker of STRONG_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Second pass: weak markers.
  dir = startDir;
  while (true) {
    for (const marker of WEAK_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return startDir; // give up, use start dir
    dir = parent;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function dbPathForRoot(rootDir: string): string {
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
  const outDir = join(homedir(), ".auger", hash);
  mkdirSync(outDir, { recursive: true });
  return join(outDir, "index.db");
}
