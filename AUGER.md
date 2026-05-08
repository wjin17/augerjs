# Auger MVP Build Prompt

You are helping build **Auger**, a TypeScript-native, manifest-driven codebase indexer and MCP server for LLMs. It runs locally as a daemon, watches the repo for file changes, and answers symbol/caller/trace queries in milliseconds.

This prompt takes you from an empty folder to a working MVP. Follow it step by step. Do not skip steps. Do not deviate from the decisions already made — they are listed in §0.

---

## §0 — Locked decisions (do not revisit)

- **Name**: Auger. npm scope: `@augerjs`. CLI command: `auger`.
- **Language**: TypeScript, ESM, strict mode.
- **Package manager / runtime**: Bun for dev and build, Node for runtime distribution.
- **Storage**: SQLite via `better-sqlite3`, with FTS5 for text search.
- **TS parser**: `ts-morph`.
- **Ruby parser**: `tree-sitter` + `tree-sitter-ruby` via `node-tree-sitter`.
- **File watcher**: `chokidar`.
- **MCP SDK**: `@modelcontextprotocol/sdk`.
- **Test runner**: `vitest`.
- **Repo layout**: monorepo with workspaces (`packages/core`, `packages/mcp`, `packages/cli`).
- **Output**: stored in `~/.auger/<project-name>/` — never inside the repo.
- **MCP transport for MVP**: stdio.

The 6 MCP tools are locked:

1. `find_symbol(name)` — locate where a symbol is defined.
2. `get_symbol(name)` — full record: signature, docstring, callers, callees.
3. `trace_callers(name)` — recursive upstream dependencies.
4. `trace_callees(name)` — recursive downstream dependencies.
5. `search(query)` — FTS over names, signatures, docstrings.
6. `get_file_symbols(path)` — all symbols defined in a file.

---

## §1 — Prerequisites

Before starting, confirm you have:

```bash
node --version   # v20+ required
bun --version    # 1.x required (install: curl -fsSL https://bun.sh/install | bash)
git --version
```

Also confirm a clean empty directory to work in. Throughout this prompt, the working dir is `~/code/auger`. Adjust paths if yours differs.

---

## §2 — Scaffold the monorepo (Phase 2.1, 2.2)

### 2.1 — Initialize

```bash
mkdir -p ~/code/auger && cd ~/code/auger
git init
bun init -y
```

### 2.2 — Convert root `package.json` to a workspace root

Replace the generated `package.json` with this:

```json
{
  "name": "@augerjs/monorepo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "bun run --filter '*' build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "bun run --filter '*' lint"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### 2.3 — Root `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

### 2.4 — Folder structure

```bash
mkdir -p packages/core/src packages/mcp/src packages/cli/src
mkdir -p fixtures/typescript fixtures/ruby
mkdir -p packages/core/test packages/mcp/test packages/cli/test
touch README.md .gitignore
```

`.gitignore`:

```
node_modules
dist
*.log
.DS_Store
.auger-local/
```

### 2.5 — Per-package `package.json` files

**`packages/core/package.json`**:

```json
{
  "name": "@augerjs/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chokidar": "^3.6.0",
    "ts-morph": "^23.0.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-ruby": "^0.21.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

**`packages/mcp/package.json`**:

```json
{
  "name": "@augerjs/mcp",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@augerjs/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

**`packages/cli/package.json`**:

```json
{
  "name": "@augerjs/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "auger": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@augerjs/core": "workspace:*",
    "@augerjs/mcp": "workspace:*",
    "commander": "^12.0.0"
  }
}
```

Each package gets its own `tsconfig.json` extending the root:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 2.6 — Install

```bash
bun install
```

Verify with `bun run typecheck` — should pass with no source files yet.

---

## §3 — SQLite schema and migrations (Phase 2.3)

Create `packages/core/src/db/schema.sql`:

```sql
-- Files indexed and their content hashes
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  language    TEXT NOT NULL,
  hash        TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);

-- All symbols extracted from files
CREATE TABLE IF NOT EXISTS symbols (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path    TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- function, class, method, interface, type, constant
  signature    TEXT,
  docstring    TEXT,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  parent_id    INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  -- Rails-specific (nullable for non-Rails)
  rails_kind   TEXT,                    -- route, association, controller_action, etc.
  rails_meta   TEXT                     -- JSON blob for extra Rails data
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Call graph: caller_id calls callee_name (resolved later to callee_id)
CREATE TABLE IF NOT EXISTS call_edges (
  caller_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name  TEXT NOT NULL,
  callee_id    INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  PRIMARY KEY (caller_id, callee_name)
);

CREATE INDEX IF NOT EXISTS idx_edges_callee_id ON call_edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_edges_callee_name ON call_edges(callee_name);

-- FTS5 virtual table over name + signature + docstring
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, docstring,
  content='symbols',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, signature, docstring)
  VALUES (new.id, new.name, new.signature, new.docstring);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
  VALUES('delete', old.id, old.name, old.signature, old.docstring);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, docstring)
  VALUES('delete', old.id, old.name, old.signature, old.docstring);
  INSERT INTO symbols_fts(rowid, name, signature, docstring)
  VALUES (new.id, new.name, new.signature, new.docstring);
END;
```

Then create `packages/core/src/db/index.ts`:

```typescript
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  return db;
}
```

Note: copy `schema.sql` into `dist/db/` during build. Add a `prebuild` script to `packages/core/package.json`:

```json
"scripts": {
  "prebuild": "mkdir -p dist/db && cp src/db/schema.sql dist/db/",
  "build": "tsc",
  ...
}
```

---

## §4 — Manifest loader (Phase 1.3, finalizing)

Create `packages/core/src/manifest.ts`:

```typescript
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ManifestSchema = z.object({
  version: z.literal(1),
  project: z.object({ name: z.string() }),
  languages: z.array(
    z.union([
      z.object({ name: z.literal("typescript"), tsconfig: z.string().optional() }),
      z.object({
        name: z.literal("ruby"),
        rails: z.boolean().optional(),
        routes: z.string().optional(),
      }),
    ])
  ),
  include: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
  output: z.object({ path: z.string() }).optional(),
  watch: z.object({ debounce: z.number().default(300) }).optional(),
  mcp: z
    .object({
      transport: z.enum(["stdio"]).default("stdio"),
      port: z.number().optional(),
    })
    .optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(path: string): Manifest {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return ManifestSchema.parse(parsed);
}
```

Add `zod` to `packages/core/package.json` dependencies.

---

## §5 — TypeScript parser (Phase 3.1, 3.2, 3.3)

Create `packages/core/src/parsers/typescript.ts`:

```typescript
import { Project, SyntaxKind, type SourceFile, type Node } from "ts-morph";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ExtractedSymbol = {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "constant";
  signature: string;
  docstring: string | null;
  startLine: number;
  endLine: number;
  parentName: string | null;
  callees: string[]; // names of called functions, resolved later
};

export type ExtractedFile = {
  path: string;
  language: "typescript";
  hash: string;
  symbols: ExtractedSymbol[];
};

export function parseTypeScriptFile(filePath: string, project: Project): ExtractedFile {
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const sf = project.addSourceFileAtPath(filePath);

  const symbols: ExtractedSymbol[] = [];

  // Top-level functions
  for (const fn of sf.getFunctions()) {
    symbols.push({
      name: fn.getName() ?? "<anonymous>",
      kind: "function",
      signature: fn.getText().split("{")[0]?.trim() ?? "",
      docstring: getJsDoc(fn),
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      parentName: null,
      callees: extractCallees(fn),
    });
  }

  // Classes and methods
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? "<anonymous>";
    symbols.push({
      name: className,
      kind: "class",
      signature: `class ${className}`,
      docstring: getJsDoc(cls),
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      parentName: null,
      callees: [],
    });

    for (const method of cls.getMethods()) {
      symbols.push({
        name: method.getName(),
        kind: "method",
        signature: method.getText().split("{")[0]?.trim() ?? "",
        docstring: getJsDoc(method),
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        parentName: className,
        callees: extractCallees(method),
      });
    }
  }

  // Interfaces
  for (const iface of sf.getInterfaces()) {
    symbols.push({
      name: iface.getName(),
      kind: "interface",
      signature: `interface ${iface.getName()}`,
      docstring: getJsDoc(iface),
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
      parentName: null,
      callees: [],
    });
  }

  // Type aliases
  for (const alias of sf.getTypeAliases()) {
    symbols.push({
      name: alias.getName(),
      kind: "type",
      signature: alias.getText().trim(),
      docstring: getJsDoc(alias),
      startLine: alias.getStartLineNumber(),
      endLine: alias.getEndLineNumber(),
      parentName: null,
      callees: [],
    });
  }

  project.removeSourceFile(sf); // free memory
  return { path: filePath, language: "typescript", hash, symbols };
}

function getJsDoc(node: { getJsDocs?: () => Array<{ getDescription: () => string }> }): string | null {
  const docs = node.getJsDocs?.() ?? [];
  if (docs.length === 0) return null;
  return docs.map((d) => d.getDescription().trim()).join("\n\n") || null;
}

function extractCallees(node: Node): string[] {
  const callees = new Set<string>();
  node.forEachDescendant((n) => {
    if (n.getKind() === SyntaxKind.CallExpression) {
      const expr = (n as any).getExpression?.();
      if (!expr) return;
      const text = expr.getText();
      const name = text.split(".").pop() ?? text;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) callees.add(name);
    }
  });
  return [...callees];
}
```

Notes for the implementer:

- This is intra-file call extraction only. Cross-file resolution happens in §7 when we link `call_edges.callee_id` by name match. Acceptable for MVP.
- Dynamic dispatch (`obj[methodName]()`), aliased imports, and re-exports are out of scope for MVP. Document this in the README.

### Test fixture for §5

Create `fixtures/typescript/sample.ts`:

```typescript
/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** A simple greeter. */
export class Greeter {
  /** Returns a greeting string. */
  greet(name: string): string {
    return `Hello, ${formatName(name)}`;
  }
}

function formatName(name: string): string {
  return name.trim();
}

export interface User {
  id: number;
  name: string;
}

export type UserId = User["id"];
```

Create `packages/core/test/typescript.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "../src/parsers/typescript";
import { resolve } from "node:path";

describe("typescript parser", () => {
  it("extracts functions, classes, methods, interfaces, types", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(
      resolve(__dirname, "../../../fixtures/typescript/sample.ts"),
      project
    );

    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["Greeter", "User", "UserId", "add", "formatName", "greet"]);

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.kind).toBe("method");
    expect(greet?.parentName).toBe("Greeter");
    expect(greet?.callees).toContain("formatName");
  });
});
```

Run: `bun test packages/core/test/typescript.test.ts`. Should pass before moving on.

---

## §6 — Ruby parser (Phase 4.1, 4.2)

Create `packages/core/src/parsers/ruby.ts`:

```typescript
import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtractedFile, ExtractedSymbol } from "./typescript.js";

const parser = new Parser();
parser.setLanguage(Ruby);

export function parseRubyFile(filePath: string): ExtractedFile {
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const tree = parser.parse(content);
  const symbols: ExtractedSymbol[] = [];

  walk(tree.rootNode, null, content, symbols);

  return { path: filePath, language: "ruby" as any, hash, symbols };
}

function walk(
  node: Parser.SyntaxNode,
  parentName: string | null,
  source: string,
  out: ExtractedSymbol[]
) {
  if (node.type === "method") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      out.push({
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: "method",
        signature: firstLine(source.slice(node.startIndex, node.endIndex)),
        docstring: null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentName,
        callees: extractRubyCallees(node, source),
      });
    }
  } else if (node.type === "class") {
    const nameNode = node.childForFieldName("name");
    const className = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : "<anonymous>";
    out.push({
      name: className,
      kind: "class",
      signature: `class ${className}`,
      docstring: null,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentName: null,
      callees: [],
    });
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i)!, className, source, out);
    }
    return;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i)!, parentName, source, out);
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

function extractRubyCallees(node: Parser.SyntaxNode, source: string): string[] {
  const callees = new Set<string>();
  function visit(n: Parser.SyntaxNode) {
    if (n.type === "call" || n.type === "method_call") {
      const methodNode = n.childForFieldName("method") ?? n.childForFieldName("name");
      if (methodNode) {
        const name = source.slice(methodNode.startIndex, methodNode.endIndex);
        if (/^[a-z_][\w]*[?!=]?$/.test(name)) callees.add(name);
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
  }
  visit(node);
  return [...callees];
}
```

### Rails-aware extraction (deferred for MVP, stub it)

For the MVP, ship plain Ruby parsing only. Add a TODO in the file:

```typescript
// TODO(rails): When manifest.languages includes { ruby: { rails: true } },
// also parse config/routes.rb for routes, scan ApplicationRecord subclasses
// for has_many/belongs_to associations, and tag controller actions
// (public methods on classes ending in 'Controller' under app/controllers).
```

Document this clearly in the README as "Rails-aware extraction lands in 0.2."

### Test fixture

`fixtures/ruby/sample.rb`:

```ruby
class Greeter
  def greet(name)
    "Hello, #{format_name(name)}"
  end

  def format_name(name)
    name.strip
  end
end
```

`packages/core/test/ruby.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRubyFile } from "../src/parsers/ruby";
import { resolve } from "node:path";

describe("ruby parser", () => {
  it("extracts class and methods", () => {
    const result = parseRubyFile(resolve(__dirname, "../../../fixtures/ruby/sample.rb"));
    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toContain("Greeter");
    expect(names).toContain("greet");
    expect(names).toContain("format_name");

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.callees).toContain("format_name");
  });
});
```

---

## §7 — Indexer: parse → store pipeline (Phase 2.3 finalizing)

Create `packages/core/src/indexer.ts`:

```typescript
import type Database from "better-sqlite3";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "./parsers/typescript.js";
import { parseRubyFile } from "./parsers/ruby.js";

export class Indexer {
  private project = new Project({ useInMemoryFileSystem: false });

  constructor(private db: Database.Database) {}

  indexFile(filePath: string, language: "typescript" | "ruby") {
    const extracted =
      language === "typescript"
        ? parseTypeScriptFile(filePath, this.project)
        : parseRubyFile(filePath);

    const tx = this.db.transaction(() => {
      // Replace file's symbols
      this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      this.db
        .prepare(
          "INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)"
        )
        .run(filePath, language, extracted.hash, Date.now());

      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols (file_path, name, kind, signature, docstring, start_line, end_line, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertEdge = this.db.prepare(
        "INSERT OR IGNORE INTO call_edges (caller_id, callee_name) VALUES (?, ?)"
      );

      // First pass: insert symbols, capture parent ids
      const parentIds = new Map<string, number>();
      for (const sym of extracted.symbols) {
        if (sym.parentName === null) {
          const result = insertSymbol.run(
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.docstring,
            sym.startLine,
            sym.endLine,
            null
          );
          parentIds.set(sym.name, Number(result.lastInsertRowid));
        }
      }

      // Second pass: child symbols + edges
      for (const sym of extracted.symbols) {
        if (sym.parentName !== null) {
          const parentId = parentIds.get(sym.parentName) ?? null;
          const result = insertSymbol.run(
            filePath,
            sym.name,
            sym.kind,
            sym.signature,
            sym.docstring,
            sym.startLine,
            sym.endLine,
            parentId
          );
          for (const callee of sym.callees) {
            insertEdge.run(Number(result.lastInsertRowid), callee);
          }
        } else {
          const id = parentIds.get(sym.name);
          if (id !== undefined) {
            for (const callee of sym.callees) insertEdge.run(id, callee);
          }
        }
      }

      // Resolve callee_id by name match (cross-file, naive)
      this.db.exec(`
        UPDATE call_edges
        SET callee_id = (
          SELECT id FROM symbols WHERE symbols.name = call_edges.callee_name LIMIT 1
        )
        WHERE callee_id IS NULL
      `);
    });

    tx();
  }

  removeFile(filePath: string) {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    // CASCADE handles symbols and edges
  }
}
```

---

## §8 — File watcher (Phase 5)

Create `packages/core/src/watcher.ts`:

```typescript
import chokidar from "chokidar";
import { extname } from "node:path";
import { Indexer } from "./indexer.js";
import type { Manifest } from "./manifest.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export function startWatcher(
  manifest: Manifest,
  rootDir: string,
  db: Database.Database,
  indexer: Indexer
) {
  const watcher = chokidar.watch(manifest.include, {
    cwd: rootDir,
    ignored: manifest.exclude,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: manifest.watch?.debounce ?? 300 },
  });

  const langFor = (path: string): "typescript" | "ruby" | null => {
    const ext = extname(path);
    if (ext === ".ts" || ext === ".tsx") return "typescript";
    if (ext === ".rb") return "ruby";
    return null;
  };

  const handle = (path: string) => {
    const lang = langFor(path);
    if (!lang) return;

    const fullPath = `${rootDir}/${path}`;
    const content = readFileSync(fullPath, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");

    const existing = db
      .prepare("SELECT hash FROM files WHERE path = ?")
      .get(fullPath) as { hash: string } | undefined;

    if (existing?.hash === hash) return; // no-op
    indexer.indexFile(fullPath, lang);
  };

  watcher.on("add", handle);
  watcher.on("change", handle);
  watcher.on("unlink", (path) => indexer.removeFile(`${rootDir}/${path}`));

  return watcher;
}
```

---

## §9 — MCP server with the 6 tools (Phase 6)

Create `packages/mcp/src/index.ts`:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

export function createMcpServer(db: Database.Database) {
  const server = new Server(
    { name: "auger", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "find_symbol",
        description:
          "Locate where a symbol is defined. Returns file path, line number, and symbol type. Use this when you know a name and need to find it.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "get_symbol",
        description:
          "Get the full record for a named symbol: signature, docstring, callers, and callees. Use this instead of find_symbol when you need to understand a symbol, not just locate it.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "trace_callers",
        description:
          "Recursively walk upstream from a symbol — everything that calls it, and everything that calls those callers. Use this to understand the blast radius of a change.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, max_depth: { type: "number" } },
          required: ["name"],
        },
      },
      {
        name: "trace_callees",
        description:
          "Recursively walk downstream from a symbol — everything it calls, and everything those call. Use this to trace execution flow.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, max_depth: { type: "number" } },
          required: ["name"],
        },
      },
      {
        name: "search",
        description:
          "Full-text search across symbol names, signatures, and docstrings. Searches the index, not raw file contents.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "get_file_symbols",
        description:
          "List all symbols defined in a file: functions, classes, methods, constants, and types.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = handleTool(db, name, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

function handleTool(db: Database.Database, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "find_symbol": {
      const rows = db
        .prepare("SELECT name, kind, file_path, start_line FROM symbols WHERE name = ?")
        .all(args.name);
      return { matches: rows };
    }
    case "get_symbol": {
      const sym = db
        .prepare("SELECT * FROM symbols WHERE name = ? LIMIT 1")
        .get(args.name) as { id: number } | undefined;
      if (!sym) return { found: false };
      const callers = db
        .prepare(
          "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.caller_id WHERE e.callee_id = ?"
        )
        .all(sym.id);
      const callees = db
        .prepare(
          "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.callee_id WHERE e.caller_id = ?"
        )
        .all(sym.id);
      return { ...sym, callers, callees };
    }
    case "trace_callers": {
      const maxDepth = (args.max_depth as number) ?? 5;
      return traceGraph(db, args.name as string, "callers", maxDepth);
    }
    case "trace_callees": {
      const maxDepth = (args.max_depth as number) ?? 5;
      return traceGraph(db, args.name as string, "callees", maxDepth);
    }
    case "search": {
      const rows = db
        .prepare(
          `SELECT s.name, s.kind, s.file_path, s.start_line, s.signature
           FROM symbols_fts f JOIN symbols s ON s.id = f.rowid
           WHERE symbols_fts MATCH ? LIMIT 50`
        )
        .all(args.query);
      return { results: rows };
    }
    case "get_file_symbols": {
      const rows = db
        .prepare("SELECT name, kind, signature, start_line, end_line FROM symbols WHERE file_path = ? ORDER BY start_line")
        .all(args.path);
      return { symbols: rows };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function traceGraph(
  db: Database.Database,
  startName: string,
  direction: "callers" | "callees",
  maxDepth: number
) {
  const cte =
    direction === "callers"
      ? `
      WITH RECURSIVE chain(id, name, file_path, depth) AS (
        SELECT s.id, s.name, s.file_path, 0 FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, c.depth + 1
        FROM chain c
        JOIN call_edges e ON e.callee_id = c.id
        JOIN symbols s ON s.id = e.caller_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, depth FROM chain WHERE depth > 0 ORDER BY depth, name
    `
      : `
      WITH RECURSIVE chain(id, name, file_path, depth) AS (
        SELECT s.id, s.name, s.file_path, 0 FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, c.depth + 1
        FROM chain c
        JOIN call_edges e ON e.caller_id = c.id
        JOIN symbols s ON s.id = e.callee_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, depth FROM chain WHERE depth > 0 ORDER BY depth, name
    `;
  return { trace: db.prepare(cte).all(startName, maxDepth) };
}

export async function runMcpStdio(db: Database.Database) {
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

---

## §10 — CLI (Phase 2.4)

Create `packages/cli/src/index.ts`:

```typescript
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
```

Update `packages/core/src/index.ts` to re-export the public API:

```typescript
export { loadManifest } from "./manifest.js";
export { openDb } from "./db/index.js";
export { Indexer } from "./indexer.js";
export { startWatcher } from "./watcher.js";
```

---

## §11 — End-to-end smoke test

```bash
bun run build

# Make a tiny test project
mkdir /tmp/test-auger && cd /tmp/test-auger
mkdir src
cat > src/math.ts <<'EOF'
export function add(a: number, b: number) { return a + b; }
export function mul(a: number, b: number) { return add(a, a) * b; }
EOF

# Init and start
node ~/code/auger/packages/cli/dist/index.js init
# In another terminal:
node ~/code/auger/packages/cli/dist/index.js status
```

Add a manual MCP test by piping a `tools/list` JSON-RPC message into the stdio server. You can also wire it into Claude Desktop with a config like:

```json
{
  "mcpServers": {
    "auger": {
      "command": "node",
      "args": ["/Users/you/code/auger/packages/cli/dist/index.js", "start"],
      "cwd": "/tmp/test-auger"
    }
  }
}
```

Then in Claude Desktop, ask: "Use the auger tools to find the symbol `add`." If you get back a result with `file_path` and `start_line`, the MVP works.

---

## §12 — Definition of done for the MVP

- [ ] `bun install && bun run build` succeeds with no errors.
- [ ] `bun test` passes both `typescript.test.ts` and `ruby.test.ts`.
- [ ] `auger init` creates a valid `.auger.yml`.
- [ ] `auger start` watches files and indexes them on change.
- [ ] `auger status` reports correct file and symbol counts.
- [ ] All 6 MCP tools return sensible results when invoked via Claude Desktop or Cursor on a small TS+Ruby project.
- [ ] No file is ever written inside the user's repo (only `~/.auger/<name>/`).

When all boxes are checked, you have an MVP. Then move to Phase 7 — harden, write the README, set up CI, publish 0.1.0.

---

## Notes for the implementer

- Don't add features that aren't in this prompt. Rails-aware extraction, semantic search, HTTP transport, and shared daemons are explicitly out of scope for the MVP.
- If something fails, fix the failing step before moving on. Don't accumulate broken steps.
- The TypeScript and Ruby parsers are intentionally minimal — they're the highest-risk parts. Get them tested first, before wiring up the rest.
- Cross-file callee resolution via `WHERE name = name` is naive and will produce false positives where two unrelated symbols share a name. That's acceptable for v0.1; a proper resolver lands in 0.2.