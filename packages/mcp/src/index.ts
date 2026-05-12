import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

// Resolves the correct project DB for a tool call.
// For file-based tools the DB is derived from the file path; for name-based
// tools the caller may pass an explicit `root` (any path inside the project).
export type GetDb = (root?: string) => Promise<Database.Database>;
export type GetStatus = (root?: string) => { db: Database.Database; isReady: boolean } | null;
export type Reindex = (root?: string) => Promise<void>;

const ROOT_PROP = {
  root: {
    type: "string",
    description:
      "Optional path to any file or directory inside the target project. " +
      "Omit to use the current project (the directory Claude Code was opened in).",
  },
} as const;

export function createMcpServer(getDb: GetDb, getStatus: GetStatus, reindex?: Reindex) {
  const server = new Server({ name: "auger", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "locate_symbol",
        description:
          "Find where a symbol is defined. Returns file path and line number. Cheaper than grep+read — results in <1ms.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, ...ROOT_PROP },
          required: ["name"],
        },
      },
      {
        name: "inspect_symbol",
        description:
          "Get the full record for a symbol: signature, docstring, direct callers, and direct callees. Use this when you need to understand a symbol, not just locate it.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, ...ROOT_PROP },
          required: ["name"],
        },
      },
      {
        name: "trace_callers",
        description:
          "Recursively walk upstream from a symbol — everything that calls it, and everything that calls those callers. Use this to understand the impact of changing a symbol.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, max_depth: { type: "number" }, ...ROOT_PROP },
          required: ["name"],
        },
      },
      {
        name: "trace_callees",
        description:
          "Recursively walk downstream from a symbol — everything it calls, and everything those call. Use this to understand blast radius before a refactor.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, max_depth: { type: "number" }, ...ROOT_PROP },
          required: ["name"],
        },
      },
      {
        name: "search",
        description:
          "Full-text search across symbol names, signatures, and docstrings. Searches the index, not raw file contents.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, ...ROOT_PROP },
          required: ["query"],
        },
      },
      {
        name: "outline",
        description:
          "Get a structural overview of a file before deciding whether to read it. Returns classes and their methods — cheaper than reading the file. Pass full: true to include all symbols and anonymous callbacks.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, full: { type: "boolean" } },
          required: ["path"],
        },
      },
      {
        name: "indexing_status",
        description:
          "Check whether the auger index has finished building and how many files and symbols are indexed so far. Call this if other tools return no results or you suspect the index is still warming up.",
        inputSchema: {
          type: "object",
          properties: { ...ROOT_PROP },
        },
      },
      {
        name: "reindex",
        description:
          "Drop and rebuild the symbol index for a project from scratch. Use this if the index appears stale or other tools are returning empty results after an update to auger.",
        inputSchema: {
          type: "object",
          properties: { ...ROOT_PROP },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Resolve the right project DB for this call.
    // outline derives the project from its `path` argument;
    // all other tools use the explicit `root` param (or fall back to default).
    let root: string | undefined;
    if (name === "outline" && typeof a["path"] === "string") {
      root = dirname(a["path"]);
    } else if (typeof a["root"] === "string") {
      root = a["root"];
    }

    if (name === "reindex") {
      if (reindex) {
        reindex(root).catch(() => {});
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Reindex started — use indexing_status to check progress." }) }] };
    }

    if (name === "indexing_status") {
      const status = getStatus(root);
      if (!status) {
        return { content: [{ type: "text", text: JSON.stringify({ isReady: false, files: 0, symbols: 0, message: "Index not started yet." }) }] };
      }
      const { db, isReady } = status;
      const files = (db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }).n;
      const symbols = (db.prepare("SELECT COUNT(*) as n FROM symbols WHERE is_anonymous = 0").get() as { n: number }).n;
      const message = isReady ? "Index ready." : "Index is still building — results from other tools may be incomplete.";
      return { content: [{ type: "text", text: JSON.stringify({ isReady, files, symbols, message }) }] };
    }

    const db = await getDb(root);
    const result = handleTool(db, name, a);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

type WithLocation = { file_path: string; start_line: number; [k: string]: unknown };

function withLocation<T extends WithLocation>(row: T): T & { location: string } {
  return { ...row, location: `${row.file_path}:${row.start_line}` };
}

export function handleTool(
  db: Database.Database,
  name: string,
  args: Record<string, unknown>
): unknown {
  switch (name) {
    case "locate_symbol": {
      const rows = db
        .prepare(
          "SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0"
        )
        .all(args["name"]) as WithLocation[];
      return { matches: rows.map(withLocation) };
    }
    case "inspect_symbol": {
      const syms = db
        .prepare("SELECT * FROM symbols WHERE name = ? AND is_anonymous = 0")
        .all(args["name"]) as (WithLocation & { id: number })[];
      if (syms.length === 0) return { found: false };
      const results = syms.map((sym) => {
        const callers = (
          db
            .prepare(
              "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.caller_id WHERE e.callee_id = ?"
            )
            .all(sym.id) as WithLocation[]
        ).map(withLocation);
        const callees = (
          db
            .prepare(
              "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.callee_id WHERE e.caller_id = ?"
            )
            .all(sym.id) as WithLocation[]
        ).map(withLocation);
        return { ...withLocation(sym), callers, callees };
      });
      return results.length === 1 ? results[0] : { matches: results };
    }
    case "trace_callers": {
      const maxDepth = (args["max_depth"] as number) ?? 5;
      return traceGraph(db, args["name"] as string, "callers", maxDepth);
    }
    case "trace_callees": {
      const maxDepth = (args["max_depth"] as number) ?? 5;
      return traceGraph(db, args["name"] as string, "callees", maxDepth);
    }
    case "search": {
      const rows = db
        .prepare(
          `SELECT s.name, s.kind, s.file_path, s.start_line, s.signature
           FROM symbols_fts f JOIN symbols s ON s.id = f.rowid
           WHERE symbols_fts MATCH ? AND s.is_anonymous = 0 LIMIT 50`
        )
        .all(args["query"]) as WithLocation[];
      return { results: rows.map(withLocation) };
    }
    case "outline": {
      const path = args["path"] as string;
      if (args["full"] === true) {
        const rows = db
          .prepare(
            "SELECT name, kind, signature, file_path, start_line, end_line FROM symbols WHERE file_path = ? ORDER BY start_line"
          )
          .all(path) as WithLocation[];
        return { symbols: rows.map(withLocation) };
      }
      // One level deep: top-level symbols + their direct named children, no anonymous
      type RowWithId = WithLocation & { id: number };
      const topRows = db
        .prepare(
          "SELECT id, name, kind, signature, file_path, start_line, end_line FROM symbols WHERE file_path = ? AND parent_id IS NULL ORDER BY start_line"
        )
        .all(path) as RowWithId[];
      if (topRows.length === 0) return { symbols: [] };
      const topIds = topRows.map((r) => r.id);
      const ph = topIds.map(() => "?").join(", ");
      const childRows = db
        .prepare(
          `SELECT name, kind, signature, file_path, start_line, end_line FROM symbols WHERE file_path = ? AND parent_id IN (${ph}) AND is_anonymous = 0 ORDER BY start_line`
        )
        .all(path, ...topIds) as WithLocation[];
      const topWithoutId = topRows.map(({ id: _id, ...rest }) => rest as WithLocation);
      const all = [...topWithoutId, ...childRows].sort((a, b) => a.start_line - b.start_line);
      return { symbols: all.map(withLocation) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

type TraceRow = WithLocation & { id: number; name: string; depth: number; is_anonymous: number };

function traceGraph(
  db: Database.Database,
  startName: string,
  direction: "callers" | "callees",
  maxDepth: number
) {
  const cte =
    direction === "callers"
      ? `
      WITH RECURSIVE chain(id, name, file_path, start_line, depth, is_anonymous) AS (
        SELECT s.id, s.name, s.file_path, s.start_line, 0, s.is_anonymous FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, s.start_line, c.depth + 1, s.is_anonymous
        FROM chain c
        JOIN call_edges e ON e.callee_id = c.id
        JOIN symbols s ON s.id = e.caller_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, start_line, depth, is_anonymous FROM chain WHERE depth > 0 ORDER BY depth, name
    `
      : `
      WITH RECURSIVE chain(id, name, file_path, start_line, depth, is_anonymous) AS (
        SELECT s.id, s.name, s.file_path, s.start_line, 0, s.is_anonymous FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, s.start_line, c.depth + 1, s.is_anonymous
        FROM chain c
        JOIN call_edges e ON e.caller_id = c.id
        JOIN symbols s ON s.id = e.callee_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, start_line, depth, is_anonymous FROM chain WHERE depth > 0 ORDER BY depth, name
    `;
  const rows = db.prepare(cte).all(startName, maxDepth) as TraceRow[];

  // Group anonymous entries by depth+file to reduce noise.
  // Named symbols are emitted individually; anonymous ones become summary entries.
  const anonGroups = new Map<
    string,
    { count: number; file_path: string; start_line: number; depth: number }
  >();
  const named: ReturnType<typeof withLocation>[] = [];

  for (const row of rows) {
    if (row.is_anonymous) {
      const key = `${row.depth}:${row.file_path}`;
      if (!anonGroups.has(key)) {
        anonGroups.set(key, {
          count: 0,
          file_path: row.file_path,
          start_line: row.start_line,
          depth: row.depth,
        });
      }
      anonGroups.get(key)!.count++;
    } else {
      named.push(withLocation(row));
    }
  }

  const summaries = [...anonGroups.values()].map(({ count, file_path, start_line, depth }) => ({
    name: `[${count} anonymous callback${count === 1 ? "" : "s"}]`,
    file_path,
    start_line,
    depth,
    location: `${file_path}:${start_line}`,
  }));

  const trace = [...named, ...summaries].sort((a, b) => {
    const da = ((a as Record<string, unknown>)["depth"] as number) ?? 0;
    const db_ = ((b as Record<string, unknown>)["depth"] as number) ?? 0;
    const na = ((a as Record<string, unknown>)["name"] as string) ?? "";
    const nb = ((b as Record<string, unknown>)["name"] as string) ?? "";
    return da !== db_ ? da - db_ : na.localeCompare(nb);
  });

  return { trace };
}

export async function runMcpStdio(getDb: GetDb, getStatus: GetStatus, reindex?: Reindex) {
  const server = createMcpServer(getDb, getStatus, reindex);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function runMcpHttp(getDb: GetDb, getStatus: GetStatus, reindex: Reindex | undefined, port: number): Promise<void> {
  const server = createMcpServer(getDb, getStatus, reindex);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`Auger MCP server listening on http://localhost:${port}/mcp`);

  process.once("SIGINT", () => {
    httpServer.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    httpServer.close();
    process.exit(0);
  });

  await new Promise<void>(() => {});
}
