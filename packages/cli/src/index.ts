#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

program
  .command("init")
  .description("Create .mcp.json for Claude Code integration")
  .action(() => {
    if (!existsSync(".mcp.json")) {
      writeFileSync(
        ".mcp.json",
        JSON.stringify(
          { mcpServers: { auger: { command: "auger", args: ["start"] } } },
          null,
          2
        ) + "\n"
      );
      console.log("Created .mcp.json");
    } else {
      console.log(".mcp.json already exists — skipped");
    }

    if (existsSync(".auger.yml")) {
      console.log(".auger.yml found — custom include/exclude will be used.");
    } else {
      console.log(
        "No .auger.yml — using defaults (all TS/Ruby files, excludes node_modules/dist).\n" +
        "Create .auger.yml to customise include/exclude patterns."
      );
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

    // Pre-warm the startup project: index if needed, wait for initial scan.
    process.stderr.write(`auger: indexing ${rootDir}…\n`);
    await registry.getDb();
    process.stderr.write(`auger: ready\n`);

    await runMcpStdio((root?) => registry.getDb(root));

    process.on("SIGINT", () => { registry.close(); process.exit(0); });
    process.on("SIGTERM", () => { registry.close(); process.exit(0); });
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

function openIndex(): ReturnType<typeof openDb> {
  const rootDir = findProjectRoot(process.cwd());
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
  .action((name) => print(handleTool(openIndex(), "find_symbol", { name })));

program
  .command("get_symbol <name>")
  .description("Full record: signature, docstring, callers, callees")
  .action((name) => print(handleTool(openIndex(), "get_symbol", { name })));

program
  .command("trace_callers <name>")
  .description("Recursive upstream call graph")
  .option("-d, --depth <n>", "max depth", "5")
  .action((name, opts) =>
    print(handleTool(openIndex(), "trace_callers", { name, max_depth: Number(opts.depth) }))
  );

program
  .command("trace_callees <name>")
  .description("Recursive downstream call graph")
  .option("-d, --depth <n>", "max depth", "5")
  .action((name, opts) =>
    print(handleTool(openIndex(), "trace_callees", { name, max_depth: Number(opts.depth) }))
  );

program
  .command("search <query>")
  .description("Full-text search over symbol names, signatures, and docstrings")
  .action((query) => print(handleTool(openIndex(), "search", { query })));

program
  .command("get_file_symbols <path>")
  .description("All symbols defined in a file")
  .action((path) => print(handleTool(openIndex(), "get_file_symbols", { path: resolve(path) })));

program.parseAsync();
