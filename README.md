# Auger

[![CI](https://github.com/wjin17/augerjs/actions/workflows/ci.yml/badge.svg)](https://github.com/wjin17/augerjs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-green.svg)](https://modelcontextprotocol.io/)

A TypeScript-native, manifest-driven codebase indexer and MCP server for LLMs. Runs locally as a daemon, watches your repo for file changes, and answers symbol/caller/trace queries in milliseconds.

## How it works

Auger parses your TypeScript and Ruby source files, extracts symbols (functions, classes, methods, types, interfaces), and stores them in a local SQLite database with FTS5 full-text search. A file watcher keeps the index current. An MCP server exposes the index as six tools that any MCP-compatible client (Claude Code, Claude Desktop, Cursor) can call.

The index is stored in `~/.auger/<project-name>/` — nothing is ever written inside your repo.

## Prerequisites

- Node.js 20+
- Bun 1.x

## Installation

```bash
# From the repo root
bun install
bun run build

# Link the CLI globally (optional)
npm link packages/cli
```

## Getting started

```bash
# 1. Create .auger.yml and .mcp.json in your project
cd /your/project
auger init

# 2. Start the file watcher as a background daemon
auger watch &

# 3. Check the index
auger status
```

The watcher keeps the index current while you work. Claude Code spawns its own lightweight MCP server per-session via the generated `.mcp.json` — no separate server process needed.

## `.auger.yml` reference

```yaml
version: 1

project:
  name: my-app           # used as the index directory name under ~/.auger/

languages:
  - name: typescript
    tsconfig: ./tsconfig.json   # optional, defaults to project root
  - name: ruby
    rails: false                # reserved for 0.2 Rails-aware extraction

include:
  - "src/**/*"
  - "app/**/*"

exclude:
  - "node_modules/**"
  - "dist/**"

watch:
  debounce: 300          # ms to wait after a write before re-indexing
```

## CLI commands

| Command | Description |
|---|---|
| `auger init` | Create `.auger.yml` and `.mcp.json` in the current directory |
| `auger watch` | Run the file watcher daemon (keep in background) |
| `auger start` | Start the MCP stdio server (spawned automatically by Claude Code) |
| `auger status` | Show indexed file and symbol counts |
| `auger find_symbol <name>` | Locate where a symbol is defined |
| `auger get_symbol <name>` | Full record: signature, docstring, callers, callees |
| `auger trace_callers <name>` | Recursive upstream call graph |
| `auger trace_callees <name>` | Recursive downstream call graph |
| `auger search <query>` | FTS over symbol names, signatures, and docstrings |
| `auger get_file_symbols <path>` | All symbols defined in a file |

## MCP tools

| Tool | Input | Description |
|---|---|---|
| `find_symbol` | `name` | Locate where a symbol is defined |
| `get_symbol` | `name` | Full record: signature, docstring, callers, callees |
| `trace_callers` | `name`, `max_depth?` | Recursive upstream call graph |
| `trace_callees` | `name`, `max_depth?` | Recursive downstream call graph |
| `search` | `query` | FTS over symbol names, signatures, and docstrings |
| `get_file_symbols` | `path` | All symbols defined in a file |

All results include a `location` field in `file:line` format.

## Wiring into Claude Code

`auger init` generates a `.mcp.json` automatically:

```json
{
  "mcpServers": {
    "auger": {
      "command": "npx",
      "args": ["auger", "start"]
    }
  }
}
```

Commit this alongside `.auger.yml`. Claude Code spawns `auger start` per session — it connects to the already-running index built by `auger watch`.

To pre-approve the server (skip the trust prompt), add to `~/.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["auger"]
}
```

## Wiring into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "auger": {
      "command": "npx",
      "args": ["auger", "start"]
    }
  }
}
```

## Development

```bash
bun install          # install dependencies
bun run build        # compile all packages
bun run test         # run the test suite
bun run typecheck    # type-check without emitting
```

## Known limitations (v0.1)

- **Arrow functions and anonymous functions are not indexed.** Only named top-level functions, classes, methods, interfaces, and type aliases are extracted.
- **Cross-file callee resolution is naive.** Call edges are resolved by matching callee names across all indexed symbols. Two unrelated symbols sharing a name will produce false positives. A proper resolver is planned for 0.2.
- **Rails-aware extraction is not implemented.** The `rails: true` manifest option is accepted but has no effect. Route parsing, association extraction, and controller action tagging are planned for 0.2.
