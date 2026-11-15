/** A JSON value: the only thing that crosses between a script and its host. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Runs in the host. `args` are the script's arguments, in order. `signal` fires when the run ends
 * for any reason before this call settles.
 */
export type HostFunction = (args: Json[], signal: AbortSignal) => Promise<Json>;

/** Throw this from a host function to choose what the script catches. */
export class HostFunctionError extends Error {
  readonly data?: Json;

  constructor(message: string, data?: Json) {
    super(message);
    this.name = "HostFunctionError";
    if (data !== undefined) this.data = data;
  }
}

export interface ScriptRequest {
  /** The body of an async function: statements, `await`, and a `return` of a JSON value. */
  code: string;
  /**
   * What the script can call. `{ call: fn }` is called as `await call("name", { ... })`;
   * `{ pubmed: { search: fn } }` as `await pubmed.search({ ... })`. Names are JavaScript
   * identifiers.
   */
  globals: Record<string, HostFunction | Record<string, HostFunction>>;
  /** The whole run, host calls included. */
  wallMs: number;
  /** Time the script's own code may run; waiting on a host call is free. */
  cpuMs: number;
  /** Host-function calls in one run. */
  maxCalls: number;
  /** One call's arguments, as JSON, in UTF-8 bytes. */
  maxCallBytes: number;
  /** The returned value, as JSON, in UTF-8 bytes. */
  maxValueBytes: number;
  /** What `console.log` and its siblings printed, in UTF-8 bytes. */
  maxLogBytes: number;
}

/** Head and tail of what the script printed; `cutBytes > 0` when the middle was cut. */
export interface ScriptLogs {
  text: string;
  cutBytes: number;
}

export type ScriptResult = { logs: ScriptLogs } & (
  | { kind: "returned"; value: Json }
  | { kind: "threw"; name: string; message: string; line?: number; column?: number }
  | { kind: "timed_out"; limit: "wall" | "cpu" }
  | { kind: "too_large"; bytes: number }
  | { kind: "aborted" }
  | { kind: "unavailable"; message: string }
);

export interface ScriptRunner {
  /**
   * Never throws for anything the script did, and never runs code twice. A malformed `request`
   * (a limit that is not a number, a global that is not an identifier) is the host's bug and
   * rejects with a `TypeError`.
   */
  run(request: ScriptRequest, signal?: AbortSignal): Promise<ScriptResult>;
  /** Ends every run still going, each as `aborted`. Later runs are `unavailable`. */
  close(): Promise<void>;
}
