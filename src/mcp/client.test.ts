// Pins implementation decisions: replies are matched to requests at the SDK transport's `send`
// (a call through the identity of its `arguments`, a list or ping through a reference in `_meta`),
// which rests on SDK internals. An SDK upgrade can break it with no type error; these tests are
// what catches that.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpClient } from "./client.js";
import { startServer, type TestServer } from "./testing/server.js";
import type { McpClient, PinnedTool, Server } from "./types.js";

const tool = (name: string): PinnedTool => ({
  name,
  listed: { name, inputSchema: { type: "object" } },
});
const clientInfo = { name: "test", version: "0" };
const stdioServer = (key = "stdio"): Server => ({
  key,
  spec: {
    transport: "stdio",
    command: process.execPath,
    args: [new URL("./testing/stdio-server.mjs", import.meta.url).pathname],
  },
});

let server: TestServer;
let client: McpClient;
const http = (key = "http"): Server => ({ key, spec: { transport: "http", url: server.url } });

/** A paged list and a check on a live session: both are matched by the same route as a call. */
async function listAndCheck(target: Server): Promise<void> {
  await client.call(target, { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 });
  const listing = await client.list(target, { timeoutMs: 5000 });
  expect(listing).toHaveProperty("tools");
  expect((listing as { tools: unknown[] }).tools.length).toBeGreaterThanOrEqual(2);
  expect(await client.check(target, { timeoutMs: 5000 })).toMatchObject({ kind: "reachable" });
}

afterEach(async () => {
  await client?.close();
  await server?.stop();
});

describe.each([{ sse: false }, { sse: true }])("over HTTP (sse: $sse)", ({ sse }) => {
  beforeEach(async () => {
    server = await startServer({ sse });
    client = createMcpClient({ clientInfo, maxReplyBytes: 50_000 });
  });

  it("gives each of three concurrent calls its own reply", async () => {
    const call = (text: string, delayMs: number) =>
      client.call(
        http(),
        { tool: tool("echo"), arguments: { text, delayMs } },
        { timeoutMs: 5000 },
      );
    const replies = await Promise.all([call("a", 60), call("b", 5), call("c", 30)]);
    expect(replies.map((r) => r.kind === "answered" && r.reply.content)).toEqual([
      [{ type: "text", text: "echo a" }],
      [{ type: "text", text: "echo b" }],
      [{ type: "text", text: "echo c" }],
    ]);
  });

  it("collects a paged list, and checks a live session", async () => {
    server.behaviour.pages = 3;
    await listAndCheck(http());
    expect(server.seen.filter((s) => s.rpc === "tools/list")).toHaveLength(3);
    expect(server.seen.filter((s) => s.rpc === "ping")).toHaveLength(1);
    expect(server.seen.filter((s) => s.rpc === "initialize")).toHaveLength(1);
  });

  it("returns the reply as the server sent it, even when the SDK would throw", async () => {
    const bad = await client.call(
      http(),
      { tool: tool("bad_blocks"), arguments: {} },
      { timeoutMs: 5000 },
    );
    expect(bad).toMatchObject({ kind: "answered", isError: false });
    const blocks = (bad as unknown as { reply: { content: unknown[] } }).reply.content;
    expect(blocks[0]).toEqual({ type: "text", text: "kept", futureKey: { nested: true } });
    expect(blocks[1]).toEqual({ type: "hologram", frames: 3 });

    const mismatch = await client.call(
      http(),
      {
        tool: {
          name: "mismatch",
          listed: { ...tool("mismatch").listed, outputSchema: { type: "object", required: ["n"] } },
        },
        arguments: {},
      },
      { timeoutMs: 5000 },
    );
    expect(mismatch).toMatchObject({
      kind: "answered",
      reply: { structuredContent: { n: "not a number" } },
    });
  });

  it("maps the server's own error and its refusal", async () => {
    expect(
      await client.call(http(), { tool: tool("fails"), arguments: {} }, { timeoutMs: 5000 }),
    ).toMatchObject({
      kind: "answered",
      isError: true,
    });
    expect(
      await client.call(http(), { tool: tool("no_such"), arguments: {} }, { timeoutMs: 5000 }),
    ).toMatchObject({
      kind: "rejected",
      code: -32602,
      reply: { code: -32602, message: "Tool no_such not found" },
    });
  });

  it("stops a reply over the limit, and keeps the session", async () => {
    const big = await client.call(
      http(),
      { tool: tool("big"), arguments: { bytes: 200_000 } },
      { timeoutMs: 5000 },
    );
    expect(big).toMatchObject({ kind: "too_large", limit: 50_000 });
    expect((big as { bytes: number }).bytes).toBeGreaterThan(50_000);
    expect(
      await client.call(
        http(),
        { tool: tool("echo"), arguments: { text: "after" } },
        { timeoutMs: 5000 },
      ),
    ).toMatchObject({ kind: "answered" });
    expect(server.seen.filter((s) => s.rpc === "initialize")).toHaveLength(1);
  });

  it("leaves other calls alone when one times out and one is aborted", async () => {
    const abort = new AbortController();
    const call = (name: string, extra: object) =>
      client.call(
        http(),
        { tool: tool(name), arguments: { text: "ok", ...extra } },
        { timeoutMs: 5000, ...extra },
      );
    const slow = client.call(http(), { tool: tool("hang"), arguments: {} }, { timeoutMs: 150 });
    const cancelled = client.call(
      http(),
      { tool: tool("hang"), arguments: {} },
      { timeoutMs: 5000, signal: abort.signal },
    );
    const fine = call("echo", { delayMs: 400 } as object);
    setTimeout(() => abort.abort(), 50);
    expect(await slow).toMatchObject({ kind: "unreachable", reason: "call_timeout", sent: true });
    expect(await cancelled).toMatchObject({ kind: "aborted", sent: true });
    expect(await fine).toMatchObject({ kind: "answered" });
    expect(server.seen.filter((s) => s.rpc === "initialize")).toHaveLength(1);
  });

  it("maps HTTP faults, and sends a call only once", async () => {
    for (const [status, reason] of [
      [429, "rate_limited"],
      [500, "server_error"],
      [503, "server_error"],
      [403, "forbidden"],
    ] as const) {
      server.behaviour.failNext = { method: "tools/call", status, count: 1 };
      expect(
        await client.call(http(), { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 }),
      ).toMatchObject({
        kind: "unreachable",
        reason,
        httpStatus: status,
      });
    }
    expect(server.seen.filter((s) => s.rpc === "tools/call")).toHaveLength(4);
  });

  it("starts a new session once when the server forgot the old one", async () => {
    for (const forgotten of [404, 400] as const) {
      server.behaviour.forgotten = forgotten;
      await client.call(http(), { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 });
      server.forgetSessions();
      const before = server.seen.filter((s) => s.rpc === "tools/call").length;
      expect(
        await client.call(
          http(),
          { tool: tool("echo"), arguments: { text: "again" } },
          { timeoutMs: 5000 },
        ),
      ).toMatchObject({ kind: "answered" });
      // the rejected send, then the resend on the new session
      expect(server.seen.filter((s) => s.rpc === "tools/call").length - before).toBe(2);
      await client.close();
    }
  });

  it("answers concurrent calls on a session the server forgot, each from its own reply", async () => {
    await client.call(http(), { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 });
    for (const delayMs of [0, 20, 200]) {
      server.forgetSessions();
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          client.call(
            http(),
            { tool: tool("echo"), arguments: { text: `${n}`, delayMs } },
            { timeoutMs: 5000 },
          ),
        ),
      );
      expect(results.map((r) => r.kind)).toEqual(["answered", "answered", "answered"]);
    }
    await client.close();
  });

  it("asks for a token before every request, and refreshes once after a 401", async () => {
    let current = "old";
    server.behaviour.auth = (token) => token === "new";
    const refreshed: string[] = [];
    const secured: Server = {
      key: "secured",
      spec: {
        transport: "http",
        url: server.url,
        auth: {
          token: async () => current,
          refresh: async () => {
            current = "new";
            refreshed.push(current);
          },
        },
      },
    };
    expect(
      await client.call(secured, { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 }),
    ).toMatchObject({ kind: "answered" });
    expect(refreshed).toEqual(["new"]);
    const noToken: Server = { key: "bare", spec: { transport: "http", url: server.url } };
    expect(
      await client.call(noToken, { tool: tool("echo"), arguments: {} }, { timeoutMs: 5000 }),
    ).toMatchObject({
      kind: "unreachable",
      reason: "unauthorized",
      httpStatus: 401,
      sent: false,
    });
  });
});

describe("over stdio", () => {
  beforeEach(() => {
    server = undefined as never;
    client = createMcpClient({ clientInfo, maxReplyBytes: 50_000 });
  });

  it("gives each of three concurrent calls its own reply", async () => {
    const call = (text: string, delayMs: number) =>
      client.call(
        stdioServer(),
        { tool: tool("echo"), arguments: { text, delayMs } },
        { timeoutMs: 5000 },
      );
    const replies = await Promise.all([call("a", 60), call("b", 5), call("c", 30)]);
    expect(replies.map((r) => r.kind === "answered" && r.reply.content)).toEqual([
      [{ type: "text", text: "echo a" }],
      [{ type: "text", text: "echo b" }],
      [{ type: "text", text: "echo c" }],
    ]);
  });

  it("collects a paged list, and checks a live session", async () => {
    await listAndCheck(stdioServer());
  });

  it("ends the session on a reply over the limit, and starts a new one", async () => {
    const big = await client.call(
      stdioServer(),
      { tool: tool("big"), arguments: { bytes: 200_000 } },
      { timeoutMs: 5000 },
    );
    expect(big).toMatchObject({ kind: "too_large", limit: 50_000 });
    expect(
      await client.call(
        stdioServer(),
        { tool: tool("echo"), arguments: { text: "after" } },
        { timeoutMs: 5000 },
      ),
    ).toMatchObject({ kind: "answered" });
  });

  it("starts a process again after it died, and never resends the call that was running", async () => {
    const died = await client.call(
      stdioServer(),
      { tool: tool("die"), arguments: {} },
      { timeoutMs: 5000 },
    );
    expect(died).toMatchObject({ kind: "unreachable", reason: "disconnected", sent: true });
    expect(
      await client.call(
        stdioServer(),
        { tool: tool("echo"), arguments: { text: "back" } },
        { timeoutMs: 5000 },
      ),
    ).toMatchObject({ kind: "answered" });
  });
});
