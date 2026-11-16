import {
  Client,
  type JSONRPCMessage,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { limitReplies } from "./reply-limit.js";
import type { JsonObject, McpEvent, Server, ServerSpec } from "./types.js";

export interface SessionConfig {
  clientInfo: { name: string; version: string };
  maxReplyBytes: number;
  fetch: typeof fetch;
  onEvent?: (event: McpEvent) => void;
}

export type SessionEnd = Extract<McpEvent, { type: "session_ended" }>["reason"];

/** One request's trip over the wire. The caller reads it when `exchange` returns. */
export interface Exchange {
  /** True once the transport took the request: from then on it may have run. */
  sent: boolean;
  /** The session ended while the request was in flight and no reply had come. */
  lost?: boolean;
  /** The JSON-RPC response as it came off the wire, before the SDK parsed or rejected it. */
  raw?: { result: JsonObject } | { error: JsonObject };
  /** What the SDK threw, when it threw. */
  error?: unknown;
  /** The reply was stopped at the size limit; at least this many bytes. */
  tooLarge?: number;
  id?: number | string;
}

// The SDK's own timeout would otherwise default to 60 s; every call's deadline is the client's.
const NO_SDK_TIMEOUT = 2 ** 31 - 1;
const BUFFER_EXCEEDED = "ReadBuffer exceeded";
// Marks a list or ping request: the SDK may rebuild `params` but keeps what is in `_meta`.
const REF_KEY = "io.meridian-flow/ref";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = "";
  return (chunk) => {
    const parts = (rest + chunk.toString("utf8")).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") onLine(part.replace(/\r$/, ""));
  };
}

/**
 * A live link to one MCP server. It reads each reply under the SDK: the transport's `send` names
 * the request id of the request being made (a call is matched through the identity of its
 * `arguments`, which reaches `send` unchanged; a list or ping through a reference in `_meta`,
 * which survives the SDK rebuilding `params`), and the incoming-message hook keeps the raw
 * response for that id. The outcome is decided from that raw message, not from what the SDK made
 * of it.
 *
 * A session is `ended` from the moment anything starts ending it (close, idle timer, a reply over
 * the limit, the transport closing), and leaves its registry then: the teardown that follows may
 * take seconds and must not receive new requests.
 */
export class Session {
  /** Set by the registry; called once, when the session starts ending. */
  onEnded?: (reason: SessionEnd) => void;
  ended = false;
  server = { name: "", version: "" };
  protocolVersion = "";
  instructions: string | undefined;

  private readonly client: Client;
  private readonly transport: Transport;
  private readonly waiting = new Map<object | string, Exchange>();
  private readonly byId = new Map<number | string, Exchange>();
  private readonly aborts = new Map<Exchange, () => void>();
  private closing: Promise<void> | undefined;
  private refs = 0;
  private active = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    readonly key: string,
    spec: ServerSpec,
    private readonly cfg: SessionConfig,
    private readonly idleCloseMs: number,
  ) {
    this.transport = this.makeTransport(spec);
    this.client = new Client(cfg.clientInfo, {
      // Announces no sampling, elicitation or roots: a server cannot ask the model or the user.
      capabilities: {},
      versionNegotiation: { mode: "legacy" },
    });
    this.tap();
  }

  /** Starts the process or the HTTP session and does the handshake. Throws what the SDK threw. */
  static async open(
    server: Server,
    cfg: SessionConfig,
    opts: { signal?: AbortSignal; timeoutMs: number; idleCloseMs: number },
  ): Promise<Session> {
    const session = new Session(server.key, server.spec, cfg, opts.idleCloseMs);
    try {
      await session.client.connect(session.transport, {
        timeout: opts.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      session.ended = true;
      clearTimeout(session.idleTimer);
      await session.client.close().catch(() => {});
      throw error;
    }
    const info = session.client.getServerVersion();
    session.server = { name: info?.name ?? "", version: info?.version ?? "" };
    session.protocolVersion = session.client.getNegotiatedProtocolVersion() ?? "";
    session.instructions = session.client.getInstructions();
    cfg.onEvent?.({
      type: "session_started",
      key: server.key,
      transport: server.spec.transport,
    });
    session.armIdle();
    return session;
  }

  get transportKind(): "stdio" | "http" {
    return this.transport instanceof StreamableHTTPClientTransport ? "http" : "stdio";
  }

  /** An HTTP server that issued a session id can forget it; a stateless one cannot. */
  get hasServerSession(): boolean {
    return this.transport instanceof StreamableHTTPClientTransport && !!this.transport.sessionId;
  }

  private makeTransport(spec: ServerSpec): Transport {
    const { cfg, key } = this;
    if (spec.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: spec.command,
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        stderr: "pipe",
        maxBufferSize: cfg.maxReplyBytes,
      });
      transport.stderr?.on(
        "data",
        lines((line) => cfg.onEvent?.({ type: "stderr", key, line })),
      );
      return transport;
    }
    const { auth, headers } = spec;
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      fetch: limitReplies(cfg.fetch, cfg.maxReplyBytes, (id, bytes) =>
        this.replyTooLarge(id, bytes),
      ),
      ...(headers ? { requestInit: { headers } } : {}),
      ...(auth
        ? {
            authProvider: {
              token: () => auth.token(),
              ...(auth.refresh
                ? { onUnauthorized: async () => void (await auth.refresh?.()) }
                : {}),
            },
          }
        : {}),
      // Never "follow": fetch would carry the token and custom headers to another origin.
      redirectPolicy: "same-origin",
    });
  }

  private tap(): void {
    const { transport } = this;
    // Set before connect(): the SDK chains the hooks it finds and runs ours first.
    transport.onmessage = (message: JSONRPCMessage) => {
      if (!("id" in message) || message.id === undefined || "method" in message) return;
      const exchange = this.byId.get(message.id);
      if (!exchange) return;
      if ("result" in message && isObject(message.result))
        exchange.raw = { result: message.result as JsonObject };
      else if ("error" in message) exchange.raw = { error: message.error as unknown as JsonObject };
    };
    transport.onerror = (error: Error) => {
      // The stdio reader closes the transport when a line passes the limit, and says so only here.
      if (error.message.startsWith(BUFFER_EXCEEDED)) this.stdioReplyTooLarge();
    };
    this.client.onclose = () => this.finish("disconnected");

    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      let exchange: Exchange | undefined;
      if ("method" in message && "id" in message && message.id !== undefined) {
        const params = message.params as
          | { arguments?: object; _meta?: Record<string, unknown> }
          | undefined;
        const token =
          message.method === "tools/call" ? params?.arguments : params?._meta?.[REF_KEY];
        exchange =
          typeof token === "string" || isObject(token) ? this.waiting.get(token) : undefined;
        if (exchange) {
          exchange.sent = true;
          exchange.id = message.id;
          this.byId.set(message.id, exchange);
        }
      }
      try {
        await send(message, options);
      } catch (error) {
        // Not connected means nothing was written, so the request can safely go to a new session.
        if (exchange && error instanceof SdkError && error.code === SdkErrorCode.NotConnected)
          exchange.sent = false;
        throw error;
      }
    };
  }

  private replyTooLarge(id: number | string, bytes: number): void {
    const exchange = this.byId.get(id);
    if (!exchange) return;
    exchange.tooLarge = bytes;
    this.aborts.get(exchange)?.();
  }

  private stdioReplyTooLarge(): void {
    // Which call's reply it was is known only when one call is in flight.
    const only = this.byId.size === 1 ? [...this.byId.values()][0] : undefined;
    if (only) only.tooLarge = this.cfg.maxReplyBytes + 1;
    void this.close("too_large");
  }

  /** The one place a session starts ending. Synchronous, so no later request can reach it. */
  private finish(reason: SessionEnd): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    this.cfg.onEvent?.({ type: "session_ended", key: this.key, reason });
    this.onEnded?.(reason);
    // No more replies are coming, so the calls in flight settle now, not when a child process
    // finally exits. A forgotten session is different: each call's own reply is still on the wire.
    if (reason === "forgotten") return;
    for (const [exchange, abort] of this.aborts) {
      exchange.lost = true;
      abort();
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.idleCloseMs <= 0 || this.active > 0 || this.ended) return;
    this.idleTimer = setTimeout(() => void this.close("idle"), this.idleCloseMs);
    this.idleTimer.unref();
  }

  /**
   * Runs one request. `token` is what `send` will see to tell it from the others: the `arguments`
   * object of a call, or the reference `run` put in a list or ping's `_meta`. Never throws: the
   * Exchange says what happened.
   */
  private async exchange(
    token: object | string,
    signal: AbortSignal,
    run: (signal: AbortSignal, timeout: number) => Promise<unknown>,
  ): Promise<Exchange> {
    const exchange: Exchange = { sent: false };
    const own = new AbortController();
    this.active++;
    clearTimeout(this.idleTimer);
    this.waiting.set(token, exchange);
    this.aborts.set(exchange, () => own.abort());
    try {
      await run(AbortSignal.any([signal, own.signal]), NO_SDK_TIMEOUT);
    } catch (error) {
      exchange.error = error;
    } finally {
      this.waiting.delete(token);
      if (exchange.id !== undefined) this.byId.delete(exchange.id);
      this.aborts.delete(exchange);
      this.active--;
      this.armIdle();
    }
    return exchange;
  }

  async call(
    tool: JsonObject,
    name: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<Exchange> {
    // The pinned tool, without outputSchema: handing it over also makes the SDK check the reply
    // against that schema, which would throw away a reply from a tool that ran.
    const { outputSchema: _dropped, ...definition } = tool;
    const params = { name, arguments: args };
    return this.exchange(args, signal, (signal, timeout) =>
      this.client.callTool(params, {
        signal,
        timeout,
        toolDefinition: definition as unknown as Tool,
      }),
    );
  }

  /** A request without arguments of its own: `_meta` carries what tells it from the others. */
  private plain(
    method: "tools/list" | "ping",
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<Exchange> {
    const ref = `${++this.refs}`;
    const withRef = { ...params, _meta: { [REF_KEY]: ref } };
    return this.exchange(ref, signal, (signal, timeout) =>
      this.client.request({ method, params: withRef }, { signal, timeout }),
    );
  }

  listPage(cursor: string | undefined, signal: AbortSignal): Promise<Exchange> {
    return this.plain("tools/list", cursor === undefined ? {} : { cursor }, signal);
  }

  ping(signal: AbortSignal): Promise<Exchange> {
    return this.plain("ping", {}, signal);
  }

  close(reason: SessionEnd = "closed"): Promise<void> {
    if (!this.closing) {
      this.finish(reason);
      this.closing = this.shutDown();
    }
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    if (this.transport instanceof StreamableHTTPClientTransport) {
      // Courtesy to the server, which may keep the session in memory until told.
      await Promise.race([
        this.transport.terminateSession().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
      ]);
    }
    await this.client.close().catch(() => {});
  }
}
