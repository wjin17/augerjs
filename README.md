# Auger

[![npm](https://img.shields.io/npm/v/@augerjs/cli)](https://www.npmjs.com/package/@augerjs/cli)
[![CI](https://github.com/wjin17/augerjs/actions/workflows/ci.yml/badge.svg)](https://github.com/wjin17/augerjs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local codebase index for LLMs. Parses your TypeScript and Ruby source files, extracts every symbol, and exposes the index as an MCP server — so Claude can find definitions, trace call graphs, and search your code in microseconds instead of shelling out to grep.

```
find_symbol('registerCompletionItemProvider') → file + line in <1ms
trace_callers('formatUser')                  → full upstream call graph
search('completion provider')               → FTS across names, signatures, docs
```

Indexes on save. Works across multiple repos in a single session. No config file required.

---

## Install

```sh
npx @augerjs/cli init
```

Auger detects which MCP clients you have installed and asks which ones to configure:

```
Detected MCP clients:

  1. Claude Code — this project
     /your/project/.mcp.json
  2. Claude Code — all projects
     ~/.mcp.json
  3. Cursor
     ~/.cursor/mcp.json

Configure which? (e.g. "1 2", "all", blank to cancel):
```

Restart the selected client(s) to activate.

For a non-interactive install (all projects, Claude Code only):

```sh
npx @augerjs/cli init --global
```

## Supported clients

| Client | Config written |
|---|---|
| Claude Code (per-project) | `.mcp.json` |
| Claude Code (global) | `~/.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` |

`init` detects which clients are installed and only shows those.

---

## How it works

On each session, `auger start` is spawned automatically via the client's MCP config. It:

1. Detects the project root by walking up from `cwd` looking for `package.json`, `.git`, `go.mod`, `Gemfile`, etc. — no config file needed.
2. Opens (or creates) a local SQLite index at `~/.auger/<hash>/index.db`.
3. Scans for changed files using mtime + SHA-256 — unchanged files are skipped in milliseconds.
4. Starts watching for saves and re-indexes incrementally.
5. Serves MCP tool calls while indexing continues in the background.

Nothing is ever written inside your repo. The index lives entirely in `~/.auger/`.

---

## MCP tools

All tools accept an optional `root` parameter — any path inside the target project. Use this to query a different repo mid-session without restarting.

| Tool | Required | Optional | Description |
|---|---|---|---|
| `find_symbol` | `name` | `root` | Locate where a symbol is defined |
| `get_symbol` | `name` | `root` | Full record: signature, docstring, direct callers and callees |
| `trace_callers` | `name` | `root`, `max_depth` | Recursive upstream call graph |
| `trace_callees` | `name` | `root`, `max_depth` | Recursive downstream call graph |
| `search` | `query` | `root` | Full-text search across names, signatures, and docstrings |
| `get_file_symbols` | `path` | — | All symbols in a file (auto-routes to the right project) |
| `indexing_status` | — | `root` | Check whether the index has finished building and how many files/symbols are indexed so far |
| `reindex` | — | `root` | Drop and rebuild the index from scratch |

All results include a `location` field in `file:line` format.

### Multi-project example

```
# Working in project A, need to look something up in project B:
find_symbol("PaymentService", root="/path/to/payment-service")
search("webhook handler", root="/path/to/payment-service")
```

---

## CLI

```sh
npx @augerjs/cli <command>
```

| Command | Description |
|---|---|
| `init [--global]` | Detect installed MCP clients and configure selected ones interactively; `--global` skips the prompt and writes `~/.mcp.json` |
| `start` | Start the MCP server — called automatically by Claude Code |
| `status [--watch] [--json]` | Show indexed file and symbol counts; `--watch` polls until indexing stabilizes |
| `reindex [-r <path>]` | Clear the index so it rebuilds fresh on next start |
| `doctor` | Check MCP config and index health, exits 1 if misconfigured |
| `find_symbol <name> [-r <path>]` | Locate a symbol |
| `get_symbol <name> [-r <path>]` | Full symbol record |
| `trace_callers <name> [-r <path>]` | Upstream call graph |
| `trace_callees <name> [-r <path>]` | Downstream call graph |
| `search <query> [-r <path>]` | Full-text search |
| `get_file_symbols <path>` | All symbols in a file |

`doctor` is useful for verifying an install — exits 0 if healthy, 1 if something needs fixing.

---

## Optional: `.auger.yml`

No config file is required. By default auger indexes all `.ts`, `.tsx`, and `.rb` files, excluding `node_modules/`, `dist/`, `out/`, `build/`, and `.git/`.

Add `.auger.yml` to customise:

```yaml
version: 1
include:
  - "src/**/*"
  - "app/**/*"
exclude:
  - "node_modules/**"
  - "dist/**"
  - "**/*.generated.ts"
watch:
  debounce: 300
```

---

## Performance

Benchmarked on a synthetic corpus of 500 files, 1 warm-up + 5 measured runs.

| Language | Median | ms/file |
|---|---|---|
| Ruby | ~1.0 s | ~2.0 ms |
| TypeScript | ~1.2 s | ~2.4 ms |

Warm startup (already indexed, files unchanged): < 1 second regardless of repo size, thanks to the mtime fast-path.

---

## What gets indexed

**TypeScript / TSX**
- Functions (named, arrow, async)
- Classes, interfaces, type aliases, enums
- Class methods and field arrow functions
- Object literal methods
- Anonymous callbacks (as `<anonymous:LINE>`, file-local only)
- Intra-file call graph edges

**Ruby**
- Classes and modules
- Instance methods, class methods (`def self.method`), and `attr_reader`/`attr_writer`/`attr_accessor` (as synthetic methods)
- Call graph edges, with cross-file resolution including Rails-style autoloading (no explicit `require` needed)

**Ruby (Rails mode — auto-detected when `config/routes.rb` or `gem "rails"` in Gemfile)**
- Controller actions: public methods on `*Controller` classes are tagged `kind: "action"`; private methods remain `kind: "method"`
- ActiveRecord associations: `has_many`, `has_one`, `belongs_to`, `has_and_belongs_to_many` are indexed as synthetic methods
- Routes: `config/routes.rb` is parsed for HTTP verb routes and `resources`/`namespace` declarations (`kind: "route"`)

---

## Overriding Rails auto-detection

Rails mode is detected automatically. To force it on or off, add `.auger.yml`:

```yaml
ruby:
  rails: false   # or true to force it on
```

---

## Development

```sh
bun install
bun run build
bun run test
bun run typecheck
node packages/core/bench-index.mjs      # sequential vs parallel indexing (600 files)
node packages/core/bench-crossover.mjs  # find the crossover point for your machine
```

## Releases

This repo uses [Changesets](https://github.com/changesets/changesets). All three packages version together.

**While working on a change worth releasing:**

```sh
bun run changeset
# Follow the prompts: pick patch / minor / major, describe what changed
# This writes a file to .changeset/ — commit it with your code
```

**When ready to cut a release:**

```sh
bun run changeset:version   # Bumps all package versions, updates CHANGELOG.md
git add -A
git commit -m "chore: version packages"
git tag v<new-version>
git push origin main --tags  # Triggers CD — publishes all three packages to npm
```

Use **patch** for bug fixes, **minor** for new features, **major** for breaking changes.
