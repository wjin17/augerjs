# Auger

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
# 1. Create a .auger.yml in your project
cd /your/project
auger init

# 2. Edit .auger.yml to match your project layout, then start the daemon
auger start

# 3. Check the index in another terminal
auger status
```

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

mcp:
  transport: stdio       # only supported transport in 0.1
```

## CLI commands

| Command | Description |
|---|---|
| `auger init` | Create a default `.auger.yml` in the current directory |
| `auger start` | Start the file watcher and MCP stdio server |
| `auger status` | Show indexed file and symbol counts |

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

Add a `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "auger": {
      "command": "node",
      "args": ["/path/to/auger/packages/cli/dist/index.js", "start"],
      "cwd": "/your/project"
    }
  }
}
```

To pre-approve the server (skip the prompt on each session start), add to `~/.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["auger"]
}
```

## Wiring into Claude Desktop

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "auger": {
      "command": "node",
      "args": ["/path/to/auger/packages/cli/dist/index.js", "start"],
      "cwd": "/your/project"
    }
  }
}
```

## Development

```bash
bun install          # install dependencies
bun run build        # compile all packages
bun test             # run the test suite
bun run typecheck    # type-check without emitting
```

## Known limitations (v0.1)

- **Arrow functions and anonymous functions are not indexed.** Only named top-level functions, classes, methods, interfaces, and type aliases are extracted.
- **Cross-file callee resolution is naive.** Call edges are resolved by matching callee names across all indexed symbols. Two unrelated symbols sharing a name will produce false positives. A proper resolver is planned for 0.2.
- **Rails-aware extraction is not implemented.** The `rails: true` manifest option is accepted but has no effect. Route parsing, association extraction, and controller action tagging are planned for 0.2.
- **stdio is the only MCP transport.** HTTP transport is planned for 0.2.
