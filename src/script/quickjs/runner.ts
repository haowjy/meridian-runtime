import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
  /** QuickJS's heap limit for one run, at least 1 MiB. Default 32 MiB. */
  memoryBytes?: number;
  /** Runs at once; a run past it waits its turn. Default 16. */
  maxConcurrent?: number;
}

const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 16;
const MIN_MEMORY_BYTES = 1024 * 1024;
// WebAssembly allows 65536 pages of 64 KiB; the worker adds the 16 MiB the instance starts with.
const MAX_MEMORY_BYTES = 65536 * 65536 - 16 * 1024 * 1024;
/** The longest `setTimeout` delay; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Longest error name, error message or unavailable message a worker may send, in UTF-16 units. */
const TEXT_CHARS = 4096;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Running from source (tests, `node --experimental-strip-types`), the worker sits beside this file
// as TypeScript; in the package it is the compiled `worker.js`.
const workerUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
  import.meta.url,
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Outcome = DistributiveOmit<ScriptResult, "logs">;

/** What the host accepts from a worker, after it has checked the message. */
type WorkerMessage =
  | { type: "call"; id: number; path: string; args: string }
  | { type: "done"; outcome: Outcome };

export function createQuickJsRunner(options: QuickJsRunnerOptions = {}): ScriptRunner {
  const memoryBytes = options.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
    throw new TypeError("maxConcurrent must be a positive integer");
  if (!(memoryBytes >= MIN_MEMORY_BYTES && memoryBytes <= MAX_MEMORY_BYTES))
    throw new TypeError(
      `memoryBytes must be a number from ${MIN_MEMORY_BYTES} to ${MAX_MEMORY_BYTES}`,
    );

  // A bundle that lost the worker or the .wasm fails here, at server start, and not on the first
  // run a writer's model makes.
  if (!existsSync(fileURLToPath(workerUrl)))
    throw new Error(`the script worker is missing: ${fileURLToPath(workerUrl)}`);
  const wasmPath = createRequire(import.meta.url).resolve(
    "@jitl/quickjs-wasmfile-release-sync/wasm",
  );

  // Compiled once; each worker instantiates it afresh, so no run shares memory with another.
  let wasmModule: Promise<WebAssembly.Module> | undefined;
  const loadWasm = (): Promise<WebAssembly.Module> => {
    wasmModule ??= readFile(wasmPath)
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        wasmModule = undefined;
        throw error;
      });
    return wasmModule;
  };

  let closed = false;
  const active = new Set<Promise<ScriptResult>>();
  const running = new Set<() => void>();
  let free = maxConcurrent;
  const waiting: { turn: () => void; leave: () => void }[] = [];
  /** True when the run has a slot; false when its signal fired first or the runner closed. */
  const acquire = (signal: AbortSignal | undefined): Promise<boolean> => {
    if (signal?.aborted) return Promise.resolve(false);
    if (free > 0) {
      free--;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        turn: () => {
          signal?.removeEventListener("abort", waiter.leave);
          resolve(true);
        },
        leave: () => {
          signal?.removeEventListener("abort", waiter.leave);
          waiting.splice(waiting.indexOf(waiter), 1);
          resolve(false);
        },
      };
      waiting.push(waiter);
      signal?.addEventListener("abort", waiter.leave, { once: true });
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next.turn();
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
      return withLogs({ kind: "unavailable", message: bounded(messageOf(error)) });
    }
    if (closed || signal?.aborted) return withLogs({ kind: "aborted" });

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
        textChars: TEXT_CHARS,
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

    // Once a run has ended nothing from its worker reaches the host: no call starts, no reply is
    // posted, and every call already started has had its signal fired.
    let over = false;
    let settle: (outcome: Outcome) => void = () => {};
    const ended = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    const end = (outcome: Outcome): void => {
      if (over) return;
      over = true;
      for (const controller of calls.values()) controller.abort();
      calls.clear();
      settle(outcome);
    };
    const wall = setTimeout(
      () => end({ kind: "timed_out", limit: "wall" }),
      Math.min(request.wallMs, MAX_TIMER_MS),
    );
    const abort = () => end({ kind: "aborted" });
    running.add(abort);
    signal?.addEventListener("abort", abort, { once: true });

    worker.on("error", (error) => end({ kind: "unavailable", message: bounded(messageOf(error)) }));
    worker.on("exit", (code) =>
      end({ kind: "unavailable", message: `worker exited with ${code}` }),
    );
    worker.on("message", (raw: unknown) => {
      if (over) return;
      const message = readMessage(raw, functions, request.maxValueBytes);
      if (!message) end({ kind: "unavailable", message: "the worker sent a malformed message" });
      else if (message.type === "call") void answer(message);
      else end(message.outcome);
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
      if (!over) {
        calls.delete(message.id);
        worker.postMessage({ type: "reply", id: message.id, envelope });
      }
    }

    const outcome = await ended;
    clearTimeout(wall);
    signal?.removeEventListener("abort", abort);
    running.delete(abort);
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
      const result = (async (): Promise<ScriptResult> => {
        if (!(await acquire(signal))) return { kind: "aborted", logs: { text: "", cutBytes: 0 } };
        try {
          return await runInWorker(request, functions, signal);
        } finally {
          release();
        }
      })();
      active.add(result);
      void result.finally(() => active.delete(result));
      return result;
    },
    async close() {
      closed = true;
      for (const waiter of [...waiting]) waiter.leave();
      for (const abort of [...running]) abort();
      await Promise.allSettled([...active]);
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bounded = (value: string): string => value.slice(0, TEXT_CHARS);

/**
 * A worker's message is input from a place a script can reach: check its shape, bound its text,
 * and turn anything else into `undefined` (the run is then `unavailable`). Never throws.
 */
function readMessage(
  raw: unknown,
  functions: ReadonlyMap<string, HostFunction>,
  maxValueBytes: number,
): WorkerMessage | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.type === "call") {
    const { id, path, args } = raw;
    if (!isCount(id) || typeof path !== "string" || !functions.has(path)) return undefined;
    if (typeof args !== "string") return undefined;
    return { type: "call", id, path, args };
  }
  if (raw.type === "unavailable") {
    if (typeof raw.message !== "string") return undefined;
    return { type: "done", outcome: { kind: "unavailable", message: bounded(raw.message) } };
  }
  if (raw.type !== "done") return undefined;
  switch (raw.kind) {
    case "returned": {
      if (typeof raw.json !== "string" || raw.json.length > maxValueBytes) return undefined;
      try {
        return { type: "done", outcome: { kind: "returned", value: JSON.parse(raw.json) as Json } };
      } catch {
        return undefined;
      }
    }
    case "threw": {
      const { name, message, line, column } = raw;
      if (typeof name !== "string" || typeof message !== "string") return undefined;
      const outcome: Outcome = { kind: "threw", name: bounded(name), message: bounded(message) };
      if (isCount(line)) outcome.line = line;
      if (isCount(column)) outcome.column = column;
      return { type: "done", outcome };
    }
    case "too_large":
      return isCount(raw.bytes)
        ? { type: "done", outcome: { kind: "too_large", bytes: raw.bytes } }
        : undefined;
    case "timed_out":
      return { type: "done", outcome: { kind: "timed_out", limit: "cpu" } };
    default:
      return undefined;
  }
}
