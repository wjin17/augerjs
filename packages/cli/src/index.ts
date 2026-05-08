#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifest, openDb, Indexer, startWatcher } from "@augerjs/core";
import { runMcpStdio } from "@augerjs/mcp";

const program = new Command();
program.name("auger").description("Live codebase index for LLMs").version("0.1.0");

program
  .command("init")
  .description("Create a default .auger.yml")
  .action(() => {
    if (existsSync(".auger.yml")) {
      console.error(".auger.yml already exists");
      process.exit(1);
    }
    const projectName = process.cwd().split("/").pop() ?? "my-app";
    writeFileSync(
      ".auger.yml",
      `version: 1
project:
  name: ${projectName}
languages:
  - name: typescript
  - name: ruby
include:
  - "src/**/*"
  - "app/**/*"
  - "lib/**/*"
exclude:
  - "node_modules/**"
  - "dist/**"
watch:
  debounce: 300
mcp:
  transport: stdio
`
    );
    console.log("Created .auger.yml");
  });

program
  .command("start")
  .description("Start the watcher and MCP server")
  .action(async () => {
    const manifestPath = resolve(".auger.yml");
    if (!existsSync(manifestPath)) {
      console.error("No .auger.yml found. Run `auger init` first.");
      process.exit(1);
    }
    const manifest = loadManifest(manifestPath);
    const outDir = join(homedir(), ".auger", manifest.project.name);
    mkdirSync(outDir, { recursive: true });
    const db = openDb(join(outDir, "index.db"));
    const indexer = new Indexer(db);
    startWatcher(manifest, process.cwd(), db, indexer);
    await runMcpStdio(db);
  });

program
  .command("status")
  .description("Show index status")
  .action(() => {
    const manifestPath = resolve(".auger.yml");
    if (!existsSync(manifestPath)) {
      console.error("No .auger.yml found");
      process.exit(1);
    }
    const manifest = loadManifest(manifestPath);
    const dbPath = join(homedir(), ".auger", manifest.project.name, "index.db");
    if (!existsSync(dbPath)) {
      console.log("No index yet. Run `auger start`.");
      return;
    }
    const db = openDb(dbPath);
    const fileCount = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const symbolCount = (db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
    console.log(`Project: ${manifest.project.name}`);
    console.log(`Files: ${fileCount}`);
    console.log(`Symbols: ${symbolCount}`);
  });

program.parseAsync();
