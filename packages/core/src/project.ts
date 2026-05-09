import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROOT_MARKERS = [
  ".auger.yml",
  "package.json",
  "tsconfig.json",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pyproject.toml",
  ".git",
];

export function findProjectRoot(fromPath: string): string {
  // Accept either a file path or directory — start from the directory
  let dir = fromPath;
  // If it looks like a file (has an extension or doesn't end in /), start from its parent
  if (!fromPath.endsWith("/") && existsSync(fromPath) && !isDir(fromPath)) {
    dir = dirname(fromPath);
  }

  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return fromPath; // reached filesystem root
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
