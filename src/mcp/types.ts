export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ServerSpec =
  | {
      transport: "stdio";
      /** A path the host resolved; the package runs no package manager. */
      command: string;
      args?: string[];
      /** Added on top of the six variables the SDK copies from the host process. */
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http";
      url: string;
      /** Sent on every request to `url`'s origin, and to no other origin. */
      headers?: Record<string, string>;
      auth?: TokenSource;
    };

export interface TokenSource {
  /** Asked before every request. */
  token(): Promise<string | undefined>;
  /** Called once after a 401; the request is then sent once more. */
  refresh?(): Promise<void>;
}

export interface Server {
  /** The host's name for one session. The client keeps one session per key. */
  key: string;
  spec: ServerSpec;
}

export interface McpClientOptions {
  /** Sent to servers in the handshake. */
  clientInfo: { name: string; version: string };
  /** The handshake's limit. Default 30 s. */
  connectTimeoutMs?: number;
  /** Close a session unused this long. Default 5 min; 0 keeps it. */
  idleCloseMs?: number;
  /** After a failed start, calls fail at once for this long. Default 10 s. */
  failFastMs?: number;
  /** A larger reply is a `too_large` outcome. Default 10 MB. */
  maxReplyBytes?: number;
  /** Used for every HTTP request, so the host can limit where requests go. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Session started, session ended, a child's stderr line: for the host's logs. */
  onEvent?: (event: McpEvent) => void;
}

export type McpEvent =
  | { type: "session_started"; key: string; transport: "stdio" | "http" }
  | {
      type: "session_ended";
      key: string;
      reason: "closed" | "idle" | "disconnected" | "forgotten" | "too_large";
    }
  | { type: "stderr"; key: string; line: string };

export interface McpClient {
  list(
    server: Server,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Listing | Rejected | Unreachable | Aborted>;
  call(
    server: Server,
    call: { tool: PinnedTool; arguments: JsonObject },
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CallOutcome>;
  check(
    server: Server,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Reachable | Unreachable | Aborted>;
  /** One session, or all of them. */
  close(key?: string): Promise<void>;
}

export interface Reachable {
  kind: "reachable";
  server: { name: string; version: string };
  ms: number;
}

export interface Listing {
  /** What the server says it is. */
  server: { name: string; version: string };
  protocolVersion: string;
  /** The server's own text for a model, if it sends one. */
  instructions?: string;
  /** Every tool, exactly as the server listed it. */
  tools: JsonObject[];
}

export interface PinnedTool {
  /** The server's name for the tool, sent when it is called. */
  name: string;
  /** The server's tool object, unchanged: description, inputSchema, annotations, ... */
  listed: JsonObject;
}

export interface Pin {
  format: 1;
  server: { name: string; version: string; protocolVersion: string };
  pinnedAt: string;
  instructions?: string;
  tools: PinnedTool[];
}

export interface PinProblem {
  /** The tool the problem is about, when it has a name. */
  tool?: string;
  problem:
    | "not_listed"
    | "invalid_tool"
    | "task_required"
    | "duplicate_choice"
    | "bad_model_name"
    | "duplicate_model_name";
  message: string;
}

/** What the model is sent for one tool. Structurally the gateway's `Tool`. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonObject;
}

/** Structurally the gateway's `TextPart` and `MediaPart`. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "media"; mediaType: string; source: { data: string } };

export type CallOutcome = Answered | Rejected | TooLarge | Unreachable | Aborted;

/** The tool ran. `isError` is the server's own flag. `reply` is the raw `result` off the wire. */
export interface Answered {
  kind: "answered";
  isError: boolean;
  reply: JsonObject;
  ms: number;
}

/** The server is up and refused the request. `reply` is the raw JSON-RPC error object. */
export interface Rejected {
  kind: "rejected";
  code: number;
  message: string;
  reply: JsonObject;
  ms: number;
}

/** The server answered; the reply was not kept. `bytes` is a lower bound: what was known when reading stopped. */
export interface TooLarge {
  kind: "too_large";
  bytes: number;
  limit: number;
  ms: number;
}

/** The host's signal fired. */
export interface Aborted {
  kind: "aborted";
  sent: boolean;
  ms: number;
}

export interface Unreachable {
  kind: "unreachable";
  reason:
    | "start_failed"
    | "connect_timeout"
    | "disconnected"
    | "call_timeout"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "server_error"
    | "bad_reply";
  httpStatus?: number;
  message: string;
  /** False only when nothing can have left. */
  sent: boolean;
  ms: number;
}
