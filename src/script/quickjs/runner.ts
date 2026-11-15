import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  type HostFunction,
  HostFunctionError,
  type Json,
  type ScriptRequest,
  type ScriptResult,
  type ScriptRunner,
} from "../index.js";
import { createLogLayout, readLogs } from "./logs.js";

export interface QuickJsRunnerOptions {
  /** QuickJS's heap limit for one run. Default 32 MiB. */
  memoryBytes?: number;
  /** Runs at once; a run past it waits its turn. Default 16. */
  maxConcurrent?: number;
}

const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 16;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Running from source (tests, `node --experimental-strip-types`), the worker sits beside this file
// as TypeScript; in the package it is the compiled `worker.js`.
const workerUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
  import.meta.url,
);

type Outcome =
  | { kind: "returned"; value: Json }
  | { kind: "threw"; name: string; message: string; line?: number; column?: number }
  | { kind: "timed_out"; limit: "wall" | "cpu" }
  | { kind: "too_large"; bytes: number }
  | { kind: "aborted" }
  | { kind: "unavailable"; message: string };

type WorkerMessage =
  | { type: "call"; id: number; path: string; args: string }
  | { type: "done"; kind: "returned"; json: string }
  | { type: "done"; kind: "threw"; name: string; message: string; line?: number; column?: number }
  | { type: "done"; kind: "too_large"; bytes: number }
  | { type: "done"; kind: "timed_out" }
  | { type: "unavailable"; message: string };

export function createQuickJsRunner(options: QuickJsRunnerOptions = {}): ScriptRunner {
  const memoryBytes = options.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!(maxConcurrent >= 1)) throw new TypeError("maxConcurrent must be at least 1");

  // Compiled once, here; each worker instantiates it afresh, so no run shares memory with another.
  let wasmModule: Promise<WebAssembly.Module> | undefined;
  const loadWasm = (): Promise<WebAssembly.Module> => {
    wasmModule ??= readFile(
      createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
    )
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        wasmModule = undefined;
        throw error;
      });
    return wasmModule;
  };

  let closed = false;
  const running = new Set<() => void>();
  let free = maxConcurrent;
  const waiting: (() => void)[] = [];
  const acquire = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (free > 0) {
      free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const turn = () => {
        signal?.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        resolve(false);
      };
      waiting.push(turn);
      signal?.addEventListener("abort", leave, { once: true });
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };

  async function runInWorker(
    request: ScriptRequest,
    functions: Map<string, HostFunction>,
    signal: AbortSignal | undefined,
  ): Promise<ScriptResult> {
    const logs = createLogLayout(request.maxLogBytes);
    const withLogs = (outcome: Outcome): ScriptResult => ({ ...outcome, logs: readLogs(logs) });

    let wasm: WebAssembly.Module;
    try {
      wasm = await loadWasm();
    } catch (error) {
      return withLogs({ kind: "unavailable", message: messageOf(error) });
    }

    const calls = new Map<number, AbortController>();
    const worker = new Worker(workerUrl, {
      workerData: {
        wasmModule: wasm,
        code: request.code,
        functions: [...functions.keys()],
        memoryBytes,
        cpuMs: request.cpuMs,
        maxCalls: request.maxCalls,
        maxCallBytes: request.maxCallBytes,
        maxValueBytes: request.maxValueBytes,
        logs,
      },
      env: {},
      execArgv: [],
      // Without a small young generation each worker lets garbage pile up (a printing loop reached
      // 240 MiB before its first collection).
      resourceLimits: {
        maxYoungGenerationSizeMb: 8,
        maxOldGenerationSizeMb: 32 + Math.ceil(memoryBytes / 1048576),
      },
    });

    let end: (outcome: Outcome) => void = () => {};
    const ended = new Promise<Outcome>((resolve) => {
      end = resolve;
    });
    const wall = setTimeout(() => end({ kind: "timed_out", limit: "wall" }), request.wallMs);
    const abort = () => end({ kind: "aborted" });
    const close = () => end({ kind: "aborted" });
    running.add(close);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    worker.on("error", (error) => end({ kind: "unavailable", message: messageOf(error) }));
    worker.on("exit", (code) =>
      end({ kind: "unavailable", message: `worker exited with ${code}` }),
    );
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "call") {
        void answer(message);
      } else if (message.type === "unavailable") {
        end(
          message.type === "unavailable"
            ? { kind: "unavailable", message: message.message }
            : message,
        );
      } else if (message.kind === "returned") {
        end({ kind: "returned", value: JSON.parse(message.json) as Json });
      } else if (message.kind === "timed_out") {
        end({ kind: "timed_out", limit: "cpu" });
      } else {
        const { type: _type, ...outcome } = message;
        end(outcome);
      }
    });

    async function answer(message: { id: number; path: string; args: string }): Promise<void> {
      const controller = new AbortController();
      calls.set(message.id, controller);
      let envelope: string;
      try {
        const fn = functions.get(message.path) as HostFunction;
        const value = await fn(JSON.parse(message.args) as Json[], controller.signal);
        envelope = JSON.stringify({ ok: true, value: value ?? null });
      } catch (error) {
        envelope = JSON.stringify(failure(error));
      }
      if (calls.delete(message.id)) worker.postMessage({ type: "reply", id: message.id, envelope });
    }

    const outcome = await ended;
    clearTimeout(wall);
    signal?.removeEventListener("abort", abort);
    running.delete(close);
    for (const controller of calls.values()) controller.abort();
    calls.clear();
    await worker.terminate();
    return withLogs(outcome);
  }

  return {
    async run(request, signal) {
      const functions = hostFunctions(request);
      if (closed) {
        return {
          kind: "unavailable",
          message: "the runner is closed",
          logs: { text: "", cutBytes: 0 },
        };
      }
      if (!(await acquire(signal))) {
        return { kind: "aborted", logs: { text: "", cutBytes: 0 } };
      }
      try {
        return await runInWorker(request, functions, signal);
      } finally {
        release();
      }
    },
    async close() {
      closed = true;
      for (const abort of [...running]) abort();
    },
  };
}

/** The request's globals as one map from the path the script calls (`call`, `pubmed.search`). */
function hostFunctions(request: ScriptRequest): Map<string, HostFunction> {
  for (const key of [
    "wallMs",
    "cpuMs",
    "maxCalls",
    "maxCallBytes",
    "maxValueBytes",
    "maxLogBytes",
  ] as const) {
    if (!(request[key] >= 0)) throw new TypeError(`${key} must be a number of at least 0`);
  }
  const functions = new Map<string, HostFunction>();
  const name = (value: string): string => {
    if (!IDENTIFIER.test(value)) throw new TypeError(`"${value}" is not a JavaScript identifier`);
    return value;
  };
  for (const [global, value] of Object.entries(request.globals)) {
    if (typeof value === "function") functions.set(name(global), value);
    else {
      for (const [method, fn] of Object.entries(value))
        functions.set(`${name(global)}.${name(method)}`, fn);
    }
  }
  return functions;
}

function failure(error: unknown): { ok: false; message: string; data?: Json } {
  if (error instanceof HostFunctionError) {
    return {
      ok: false,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  return { ok: false, message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
