#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findProjectRoot, dbPathForRoot, openDb, ProjectRegistry } from "@augerjs/core";
import { runMcpStdio, handleTool } from "@augerjs/mcp";

const program = new Command();
program.name("auger").description("Live codebase index for LLMs").version("0.1.0");

// ── init ────────────────────────────────────────────────────────────────────

// npx so no global install is required — works for both developer and agent installs.
const MCP_ENTRY = { command: "npx", args: ["-y", "@augerjs/cli", "start"] };

type ClientDef = {
  name: string;
  configPath: string;
  detectionPath: string | null; // null = always shown
  format: "mcpServers" | "zed";
};

function buildClientList(): ClientDef[] {
  const home = homedir();
  const plat = process.platform;

  const claudeDesktopDir =
    plat === "win32"
      ? join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Claude")
      : plat === "darwin"
        ? join(home, "Library", "Application Support", "Claude")
        : join(home, ".config", "Claude");

  return [
    {
      name: "Claude Code — this project",
      configPath: resolve(".mcp.json"),
      detectionPath: null,
      format: "mcpServers",
    },
    {
      name: "Claude Code — all projects",
      configPath: join(home, ".mcp.json"),
      detectionPath: null,
      format: "mcpServers",
    },
    {
      name: "Claude Desktop",
      configPath: join(claudeDesktopDir, "claude_desktop_config.json"),
      detectionPath: claudeDesktopDir,
      format: "mcpServers",
    },
    {
      name: "Cursor",
      configPath: join(home, ".cursor", "mcp.json"),
      detectionPath: join(home, ".cursor"),
      format: "mcpServers",
    },
    {
      name: "Windsurf",
      configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
      detectionPath: join(home, ".codeium", "windsurf"),
      format: "mcpServers",
    },
    {
      name: "Zed",
      configPath: join(home, ".config", "zed", "settings.json"),
      detectionPath: join(home, ".config", "zed"),
      format: "zed",
    },
  ];
}

function readMcpConfig(mcpPath: string): Record<string, unknown> {
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch {
    return { mcpServers: {} };
  }
}

function writeMcpEntry(configPath: string): "added" | "exists" {
  const config = readMcpConfig(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (servers["auger"]) return "exists";
  servers["auger"] = MCP_ENTRY;
  config.mcpServers = servers;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return "added";
}

function writeZedEntry(configPath: string): "added" | "exists" {
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      /* leave empty */
    }
  }
  const servers = (config["context_servers"] ?? {}) as Record<string, unknown>;
  if (servers["auger"]) return "exists";
  servers["auger"] = { command: { path: "npx", args: ["-y", "@augerjs/cli", "start"] }, settings: {} };
  config["context_servers"] = servers;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return "added";
}

function writeClientEntry(client: ClientDef): "added" | "exists" {
  return client.format === "zed" ? writeZedEntry(client.configPath) : writeMcpEntry(client.configPath);
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

program
  .command("init")
  .description("Configure auger in one or more MCP clients. Safe to re-run.")
  .option("-g, --global", "add to ~/.mcp.json without prompting (Claude Code, all projects)")
  .action(async (opts) => {
    if (opts.global) {
      const configPath = join(homedir(), ".mcp.json");
      const result = writeMcpEntry(configPath);
      console.log(
        result === "exists" ? `auger already configured in ${configPath}` : `Added auger to ${configPath}`
      );
      console.log("\nRestart Claude Code to activate.");
      return;
    }

    const all = buildClientList();
    const detected = all.filter((c) => c.detectionPath === null || existsSync(c.detectionPath));

    if (!process.stdin.isTTY) {
      // Non-interactive fallback: write local .mcp.json
      const result = writeMcpEntry(resolve(".mcp.json"));
      console.log(result === "exists" ? "auger already configured in .mcp.json" : "Added auger to .mcp.json");
      return;
    }

    console.log("Detected MCP clients:\n");
    detected.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name}`);
      console.log(`     ${c.configPath}`);
    });
    console.log();

    const answer = await promptLine(`Configure which? (e.g. "1 2", "all", blank to cancel): `);
    if (!answer) {
      console.log("Cancelled.");
      return;
    }

    let selected: ClientDef[];
    if (answer.toLowerCase() === "all") {
      selected = detected;
    } else {
      const indices = answer
        .split(/[\s,]+/)
        .map((n) => parseInt(n, 10) - 1)
        .filter((n) => n >= 0 && n < detected.length);
      if (indices.length === 0) {
        console.log("No valid selection. Cancelled.");
        return;
      }
      selected = indices.map((i) => detected[i]!);
    }

    console.log();
    for (const client of selected) {
      const result = writeClientEntry(client);
      console.log(
        result === "exists"
          ? `  ✓ ${client.name} — already configured`
          : `  ✓ ${client.name} — added`
      );
    }
    console.log("\nRestart your MCP client(s) to activate.");
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

    await runMcpStdio(
      (root?) => registry.getDb(root),
      (root?) => registry.getStatus(root),
      (root?) => registry.reindexProject(root)
    );
  });

// ── reindex ─────────────────────────────────────────────────────────────────

program
  .command("reindex")
  .description("Clear the index and rebuild from scratch on next start")
  .option("-r, --root <path>", "path inside the target project (default: cwd)")
  .action((opts) => {
    const rootDir = opts.root ? findProjectRoot(opts.root) : findProjectRoot(process.cwd());
    const dbPath = dbPathForRoot(rootDir);
    if (!existsSync(dbPath)) {
      console.log(`No index for ${rootDir}.`);
      return;
    }
    unlinkSync(dbPath);
    console.log(`Cleared index for ${rootDir}.\nRestart your MCP client to rebuild.`);
  });

// ── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show index status for the current project")
  .option("--json", "machine-readable JSON output")
  .option("-w, --watch", "poll until indexing stabilizes, then exit")
  .action(async (opts) => {
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

    if (opts.watch) {
      const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let frame = 0;
      let stableCount = 0;
      let lastFiles = -1;
      let lastSymbols = -1;

      const db = openDb(dbPath);

      const render = (done: boolean, files: number, symbols: number) => {
        const f = files.toLocaleString().padStart(7);
        const s = symbols.toLocaleString().padStart(8);
        if (done) {
          process.stdout.write(`\r✓ ready — ${files.toLocaleString()} files, ${symbols.toLocaleString()} symbols\n`);
        } else {
          const spin = spinners[frame % spinners.length]!;
          process.stdout.write(`\r${spin} indexing ${rootDir}\n  files:   ${f}\n  symbols: ${s}\x1b[2A`);
          frame++;
        }
      };

      await new Promise<void>((resolve) => {
        const tick = () => {
          const files = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
          const symbols = (
            db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }
          ).c;

          if (files === lastFiles && symbols === lastSymbols && files > 0) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          lastFiles = files;
          lastSymbols = symbols;

          if (stableCount >= 4) {
            render(true, files, symbols);
            db.close();
            resolve();
          } else {
            render(false, files, symbols);
            setTimeout(tick, 500);
          }
        };
        tick();
      });
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
