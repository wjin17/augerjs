#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, dbPathForRoot, openDb, ProjectRegistry } from "@augerjs/core";
import { runMcpStdio, handleTool } from "@augerjs/mcp";

const program = new Command();
program.name("auger").description("Live codebase index for LLMs").version("0.1.0");

// ── init ────────────────────────────────────────────────────────────────────

// npx so no global install is required — works for both developer and agent installs.
const MCP_ENTRY = { command: "npx", args: ["-y", "@augerjs/cli", "start"] };

function readMcpConfig(mcpPath: string): Record<string, unknown> {
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpEntry(mcpPath: string): "added" | "exists" {
  const config = readMcpConfig(mcpPath);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers["auger"]) return "exists";
  servers["auger"] = MCP_ENTRY;
  config.mcpServers = servers;
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
  return "added";
}

program
  .command("init")
  .description("Wire auger into Claude Code (.mcp.json). Safe to re-run.")
  .option("-g, --global", "add to ~/.mcp.json — works for every repo, no per-project setup")
  .action((opts) => {
    const mcpPath = opts.global ? join(homedir(), ".mcp.json") : resolve(".mcp.json");
    const result = writeMcpEntry(mcpPath);

    if (result === "exists") {
      console.log(`auger already configured in ${mcpPath}`);
    } else {
      console.log(`Added auger to ${mcpPath}`);
    }

    if (opts.global) {
      console.log(
        "\nAuger will auto-detect and index any project you open in Claude Code." +
          "\nRestart Claude Code to activate." +
          "\n\nOptional: add .auger.yml to a project to customise include/exclude patterns."
      );
    } else {
      console.log("\nRestart Claude Code to activate.");
      if (!existsSync(".auger.yml")) {
        console.log("Optional: create .auger.yml to customise include/exclude patterns.");
      }
    }
  });

// ── start ───────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the MCP stdio server (spawned per-session by Claude Code)")
  .action(async () => {
    const rootDir = findProjectRoot(process.cwd());
    const dbPath = dbPathForRoot(rootDir);
    const isWarm = existsSync(dbPath);

    if (!isWarm) {
      process.stderr.write(`auger: indexing ${rootDir}…\n`);
    }

    const startTime = Date.now();
    const registry = new ProjectRegistry(rootDir);

    // Kick off indexing immediately but don't block — connect the MCP transport
    // right away so Claude Code doesn't time out on the initialize handshake.
    // Tool calls naturally await registry.getDb() until the scan completes.
    registry
      .getDb()
      .then((db) => {
        const files = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
        const symbols = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number })
          .c;
        const counts = `${files.toLocaleString()} files, ${symbols.toLocaleString()} symbols`;
        if (isWarm) {
          process.stderr.write(`auger: ready — ${counts} (warm)\n`);
        } else {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          process.stderr.write(`auger: ready — ${counts} indexed in ${elapsed}s\n`);
        }
      })
      .catch((err) => {
        process.stderr.write(`auger: failed to index ${rootDir}: ${err}\n`);
      });

    process.once("SIGINT", () => {
      registry.close();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      registry.close();
      process.exit(0);
    });

    await runMcpStdio((root?) => registry.getDb(root));
  });

// ── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show index status for the current project")
  .option("--json", "machine-readable JSON output")
  .action((opts) => {
    const rootDir = findProjectRoot(process.cwd());
    const dbPath = dbPathForRoot(rootDir);

    if (!existsSync(dbPath)) {
      if (opts.json) {
        console.log(JSON.stringify({ project: rootDir, db: dbPath, indexed: false }));
      } else {
        console.log(
          `No index for ${rootDir}.\nOpen this project in Claude Code to build the index.`
        );
      }
      return;
    }

    const db = openDb(dbPath);
    const files = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const symbols = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ project: rootDir, db: dbPath, indexed: true, files, symbols }));
    } else {
      console.log(`Project: ${rootDir}`);
      console.log(`DB:      ${dbPath}`);
      console.log(`Files:   ${files}`);
      console.log(`Symbols: ${symbols}`);
    }
  });

// ── doctor ──────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check auger configuration and index health")
  .action(() => {
    let ok = true;
    const check = (pass: boolean, msg: string) => {
      console.log(`${pass ? "✓" : "✗"} ${msg}`);
      if (!pass) ok = false;
    };

    // MCP configuration
    const globalMcp = join(homedir(), ".mcp.json");
    const localMcp = resolve(".mcp.json");
    const globalConfig = readMcpConfig(globalMcp);
    const localConfig = readMcpConfig(localMcp);
    const globalHas = !!(globalConfig.mcpServers as any)?.auger;
    const localHas = !!(localConfig.mcpServers as any)?.auger;

    if (localHas) {
      check(true, `local MCP:  ${localMcp} → auger entry found (overrides global)`);
    } else if (globalHas) {
      check(true, `global MCP: ${globalMcp} → auger entry found (applies to all projects)`);
    } else {
      check(false, `MCP config: no auger entry in ${globalMcp} or ${localMcp}`);
      console.log(`  → Run: npx @augerjs/cli init --global`);
    }

    // Index
    const rootDir = findProjectRoot(process.cwd());
    const dbPath = dbPathForRoot(rootDir);
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      const files = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
      const symbols = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
      db.close();
      check(true, `index:      ${rootDir} → ${files} files, ${symbols} symbols`);
      console.log(`  DB: ${dbPath}`);
    } else {
      check(false, `index:      ${rootDir} → no index found`);
      console.log(`  → Open this project in Claude Code to build the index`);
    }

    process.exit(ok ? 0 : 1);
  });

// ── query commands ───────────────────────────────────────────────────────────

function openIndex(root?: string): ReturnType<typeof openDb> {
  const rootDir = root ? findProjectRoot(root) : findProjectRoot(process.cwd());
  const dbPath = dbPathForRoot(rootDir);
  if (!existsSync(dbPath)) {
    console.error(`No index for ${rootDir}. Open this project in Claude Code first.`);
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
    print(
      handleTool(openIndex(opts.root), "trace_callers", { name, max_depth: Number(opts.depth) })
    )
  );

program
  .command("trace_callees <name>")
  .description("Recursive downstream call graph")
  .option("-d, --depth <n>", "max depth", "5")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((name, opts) =>
    print(
      handleTool(openIndex(opts.root), "trace_callees", { name, max_depth: Number(opts.depth) })
    )
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
