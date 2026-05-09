import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

type WithLocation = { file_path: string; start_line: number; [k: string]: unknown };

function withLocation<T extends WithLocation>(row: T): T & { location: string } {
  return { ...row, location: `${row.file_path}:${row.start_line}` };
}

export function handleTool(db: Database.Database, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "find_symbol": {
      const rows = db
        .prepare("SELECT name, kind, file_path, start_line FROM symbols WHERE name = ? AND is_anonymous = 0")
        .all(args["name"]) as WithLocation[];
      return { matches: rows.map(withLocation) };
    }
    case "get_symbol": {
      const syms = db
        .prepare("SELECT * FROM symbols WHERE name = ? AND is_anonymous = 0")
        .all(args["name"]) as (WithLocation & { id: number })[];
      if (syms.length === 0) return { found: false };
      const results = syms.map((sym) => {
        const callers = (db
          .prepare(
            "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.caller_id WHERE e.callee_id = ?"
          )
          .all(sym.id) as WithLocation[]).map(withLocation);
        const callees = (db
          .prepare(
            "SELECT s.name, s.file_path, s.start_line FROM call_edges e JOIN symbols s ON s.id = e.callee_id WHERE e.caller_id = ?"
          )
          .all(sym.id) as WithLocation[]).map(withLocation);
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
    case "get_file_symbols": {
      const rows = db
        .prepare("SELECT name, kind, signature, file_path, start_line, end_line FROM symbols WHERE file_path = ? ORDER BY start_line")
        .all(args["path"]) as WithLocation[];
      return { symbols: rows.map(withLocation) };
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
      WITH RECURSIVE chain(id, name, file_path, start_line, depth) AS (
        SELECT s.id, s.name, s.file_path, s.start_line, 0 FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, s.start_line, c.depth + 1
        FROM chain c
        JOIN call_edges e ON e.callee_id = c.id
        JOIN symbols s ON s.id = e.caller_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, start_line, depth FROM chain WHERE depth > 0 ORDER BY depth, name
    `
      : `
      WITH RECURSIVE chain(id, name, file_path, start_line, depth) AS (
        SELECT s.id, s.name, s.file_path, s.start_line, 0 FROM symbols s WHERE s.name = ?
        UNION
        SELECT s.id, s.name, s.file_path, s.start_line, c.depth + 1
        FROM chain c
        JOIN call_edges e ON e.caller_id = c.id
        JOIN symbols s ON s.id = e.callee_id
        WHERE c.depth < ?
      )
      SELECT DISTINCT id, name, file_path, start_line, depth FROM chain WHERE depth > 0 ORDER BY depth, name
    `;
  const rows = db.prepare(cte).all(startName, maxDepth) as WithLocation[];
  return { trace: rows.map(withLocation) };
}

export async function runMcpStdio(db: Database.Database) {
  const server = createMcpServer(db);
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

export async function runMcpHttp(db: Database.Database, port: number): Promise<void> {
  const server = createMcpServer(db);
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

  process.on("SIGINT", () => {
    httpServer.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    httpServer.close();
    process.exit(0);
  });

  await new Promise<void>(() => {});
}
