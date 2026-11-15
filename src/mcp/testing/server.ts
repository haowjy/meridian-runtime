// A small MCP server over Streamable HTTP, written for the cases a public server cannot produce.
// Test support: not part of the build.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Behaviour {
  /** Reply as a server-sent event stream instead of a JSON body. */
  sse: boolean;
  /** Answer 401 unless this accepts the request's bearer token. */
  auth?: (token: string | undefined) => boolean;
  /** Answer the next `count` requests of `method` with a bare HTTP status. */
  failNext?: { method: string; status: number; count: number };
  handshakeDelayMs: number;
  /** Replace the handshake with a web page. */
  htmlAtHandshake: boolean;
  /** How `ping` is answered. */
  ping: "ok" | "method_not_found" | "silent";
  /** Redirect every request to /mcp here (307). */
  redirectTo?: string;
  /** What a forgotten session gets. */
  forgotten: 404 | 400;
  /** No `mcp-session-id`: the server keeps no session. */
  stateless: boolean;
  /** Pages of `tools/list`. */
  pages: number;
}

export interface Seen {
  method: string;
  rpc?: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface TestServer {
  url: string;
  origin: string;
  seen: Seen[];
  behaviour: Behaviour;
  /** Make the server forget every session it issued. */
  forgetSessions(): void;
  stop(): Promise<void>;
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes text. Waits delayMs first.",
    inputSchema: { type: "object" },
  },
  {
    name: "bad_blocks",
    description: "Replies with blocks the SDK does not know.",
    inputSchema: { type: "object" },
  },
  {
    name: "mismatch",
    description: "Declares an output schema its reply does not meet.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
  },
  { name: "fails", description: "Reports its own error.", inputSchema: { type: "object" } },
  { name: "big", description: "Replies with `bytes` characters.", inputSchema: { type: "object" } },
  { name: "hang", description: "Never replies.", inputSchema: { type: "object" } },
  { name: "broken", description: "Has a malformed schema.", inputSchema: "not a schema" },
];

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function callTool(name: string, args: Record<string, unknown>): Promise<unknown> | undefined {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  switch (name) {
    case "echo":
      return new Promise((resolve) =>
        setTimeout(() => resolve(text(`echo ${String(args.text)}`)), Number(args.delayMs ?? 0)),
      );
    case "bad_blocks":
      return Promise.resolve({
        content: [
          { type: "text", text: "kept", futureKey: { nested: true } },
          { type: "hologram", frames: 3 },
          { type: "resource_link", name: "paper", uri: "https://example.org/paper" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      });
    case "mismatch":
      return Promise.resolve({ ...text("ran"), structuredContent: { n: "not a number" } });
    case "fails":
      return Promise.resolve({ ...text("nothing found"), isError: true });
    case "big":
      return Promise.resolve(text("x".repeat(Number(args.bytes))));
    case "hang":
      return new Promise(() => {});
    default:
      return undefined;
  }
}

export async function startServer(overrides: Partial<Behaviour> = {}): Promise<TestServer> {
  const behaviour: Behaviour = {
    sse: false,
    handshakeDelayMs: 0,
    htmlAtHandshake: false,
    ping: "ok",
    forgotten: 404,
    stateless: false,
    pages: 1,
    ...overrides,
  };
  const seen: Seen[] = [];
  const sessions = new Set<string>();
  let counter = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const authorization = req.headers.authorization;
    seen.push({
      method: req.method ?? "",
      rpc: body?.method,
      authorization,
      headers: req.headers,
      body,
    });

    if (behaviour.redirectTo && req.url === "/mcp")
      return void res.writeHead(307, { location: behaviour.redirectTo }).end();
    if (behaviour.auth && !behaviour.auth(authorization?.replace(/^Bearer /, ""))) {
      return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405).end();

    const rpc = body.method as string;
    const fail = behaviour.failNext;
    if (fail && fail.method === rpc && fail.count > 0) {
      fail.count--;
      return void res.writeHead(fail.status).end("no");
    }
    const session = req.headers["mcp-session-id"] as string | undefined;
    if (rpc !== "initialize" && session && !sessions.has(session)) {
      return void res
        .writeHead(behaviour.forgotten)
        .end(
          behaviour.forgotten === 400 ? "Bad Request: Server not initialized" : "Session not found",
        );
    }

    const reply = (
      id: unknown,
      result: unknown,
      headers: Record<string, string> = {},
      error?: unknown,
    ) => {
      const payload = JSON.stringify(error ? { jsonrpc: "2.0", id, error } : rpcResult(id, result));
      if (behaviour.sse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(payload);
      }
    };

    if (body.id === undefined) return void res.writeHead(202).end();
    switch (rpc) {
      case "initialize": {
        await new Promise((r) => setTimeout(r, behaviour.handshakeDelayMs));
        if (behaviour.htmlAtHandshake)
          return void res
            .writeHead(200, { "content-type": "text/html" })
            .end("<html>sign in</html>");
        const headers: Record<string, string> = {};
        if (!behaviour.stateless) {
          const id = `session-${++counter}`;
          sessions.add(id);
          headers["mcp-session-id"] = id;
        }
        return reply(
          body.id,
          {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "purpose-built", version: "1.0.0" },
            instructions: "Be careful.",
          },
          headers,
        );
      }
      case "ping":
        if (behaviour.ping === "silent") return;
        if (behaviour.ping === "method_not_found")
          return reply(body.id, undefined, {}, { code: -32601, message: "Method not found" });
        return reply(body.id, {});
      case "tools/list": {
        const page = Number(body.params?.cursor ?? 1);
        const tools = behaviour.pages > 1 ? [TOOLS[page - 1] ?? TOOLS[0]] : TOOLS;
        return reply(body.id, {
          tools,
          ...(page < behaviour.pages ? { nextCursor: String(page + 1) } : {}),
        });
      }
      case "tools/call": {
        const result = callTool(body.params.name, body.params.arguments ?? {});
        if (!result)
          return reply(
            body.id,
            undefined,
            {},
            { code: -32602, message: `Tool ${body.params.name} not found` },
          );
        return reply(body.id, await result);
      }
      default:
        return reply(body.id, undefined, {}, { code: -32601, message: "Method not found" });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    seen,
    behaviour,
    forgetSessions: () => sessions.clear(),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
