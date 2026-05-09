#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  findProjectRoot,
  dbPathForRoot,
  resolveManifest,
  openDb,
  Indexer,
  startWatcher,
  ProjectRegistry,
} from "@augerjs/core";
import { runMcpStdio, handleTool } from "@augerjs/mcp";

const program = new Command();
program.name("auger").description("Live codebase index for LLMs").version("0.1.0");

// ── init ────────────────────────────────────────────────────────────────────

const MCP_ENTRY = { command: "auger", args: ["start"] };

function writeMcpEntry(mcpPath: string) {
  let config: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, "utf8")); } catch {}
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers["auger"]) {
    console.log(`auger already present in ${mcpPath} — skipped`);
    return;
  }
  servers["auger"] = MCP_ENTRY;
  config.mcpServers = servers;
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Updated ${mcpPath}`);
}

program
  .command("init")
  .description("Wire auger into Claude Code (.mcp.json)")
  .option("-g, --global", "add to ~/.mcp.json (works for every repo, no per-project setup)")
  .action((opts) => {
    if (opts.global) {
      writeMcpEntry(join(homedir(), ".mcp.json"));
      console.log(
        "Done. Auger will auto-detect and index any project you open in Claude Code.\n" +
        "No .auger.yml needed — add one per-project to customise include/exclude."
      );
    } else {
      writeMcpEntry(".mcp.json");
      if (existsSync(".auger.yml")) {
        console.log(".auger.yml found — custom include/exclude will be used.");
      } else {
        console.log(
          "No .auger.yml — using defaults (all TS/Ruby files, skips node_modules/dist).\n" +
          "Create .auger.yml to customise include/exclude patterns."
        );
      }
    }
  });

// ── watch ───────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Run the file watcher daemon (keeps the index current in the background)")
  .action(() => {
    const rootDir = findProjectRoot(process.cwd());
    const manifest = resolveManifest(rootDir);
    const db = openDb(dbPathForRoot(rootDir));
    const indexer = new Indexer(db);
    console.error(`auger: watching ${rootDir}`);
    startWatcher(manifest, rootDir, db, indexer);
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
  });

// ── start ───────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the MCP stdio server (spawned per-session by Claude Code)")
  .action(async () => {
    const rootDir = findProjectRoot(process.cwd());
    const registry = new ProjectRegistry(rootDir);

    // Kick off indexing immediately but don't block — connect the MCP
    // transport right away so Claude Code doesn't time out waiting for
    // the initialize handshake. Tool calls naturally await registry.getDb()
    // which queues them until the initial scan is done.
    registry.getDb().then(() => {
      process.stderr.write(`auger: ready (${rootDir})\n`);
    });

    process.on("SIGINT", () => { registry.close(); process.exit(0); });
    process.on("SIGTERM", () => { registry.close(); process.exit(0); });

    await runMcpStdio((root?) => registry.getDb(root));
  });

// ── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show index status")
  .action(() => {
    const rootDir = findProjectRoot(process.cwd());
    const dbPath = dbPathForRoot(rootDir);
    if (!existsSync(dbPath)) {
      console.log(`No index for ${rootDir}.\nRun \`auger start\` or \`auger watch\` first.`);
      return;
    }
    const db = openDb(dbPath);
    const fileCount = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const symbolCount = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
    console.log(`Project: ${rootDir}`);
    console.log(`DB:      ${dbPath}`);
    console.log(`Files:   ${fileCount}`);
    console.log(`Symbols: ${symbolCount}`);
    db.close();
  });

// ── query commands ───────────────────────────────────────────────────────────

function openIndex(root?: string): ReturnType<typeof openDb> {
  const rootDir = root ? findProjectRoot(root) : findProjectRoot(process.cwd());
  const dbPath = dbPathForRoot(rootDir);
  if (!existsSync(dbPath)) {
    console.error(`No index for ${rootDir}. Run \`auger start\` first.`);
    process.exit(1);
  }
  return openDb(dbPath);
}

function print(result: unknown) {
  console.log(JSON.stringify(result, null, 2));
}

program
  .command("find_symbol <name>")
  .description("Locate where a symbol is defined")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((name, opts) => print(handleTool(openIndex(opts.root), "find_symbol", { name })));

program
  .command("get_symbol <name>")
  .description("Full record: signature, docstring, callers, callees")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((name, opts) => print(handleTool(openIndex(opts.root), "get_symbol", { name })));

program
  .command("trace_callers <name>")
  .description("Recursive upstream call graph")
  .option("-d, --depth <n>", "max depth", "5")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((name, opts) =>
    print(handleTool(openIndex(opts.root), "trace_callers", { name, max_depth: Number(opts.depth) }))
  );

program
  .command("trace_callees <name>")
  .description("Recursive downstream call graph")
  .option("-d, --depth <n>", "max depth", "5")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((name, opts) =>
    print(handleTool(openIndex(opts.root), "trace_callees", { name, max_depth: Number(opts.depth) }))
  );

program
  .command("search <query>")
  .description("Full-text search over symbol names, signatures, and docstrings")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((query, opts) => print(handleTool(openIndex(opts.root), "search", { query })));

program
  .command("get_file_symbols <path>")
  .description("All symbols defined in a file")
  .action((path) => {
    const absPath = resolve(path);
    print(handleTool(openIndex(absPath), "get_file_symbols", { path: absPath }));
  });

program.parseAsync();
