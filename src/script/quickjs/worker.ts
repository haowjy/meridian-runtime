// The worker thread of one script run: one QuickJS instance, ended by the host with
// `terminate()`. It imports nothing relative, so Node can run this file as it is (`runner.ts` loads
// `worker.ts` when it is itself running from source) and a bundler leaves it a single file.
import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";
import baseVariantModule from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
} from "quickjs-emscripten-core";

interface Init {
  wasmModule: WebAssembly.Module;
  code: string;
  /** Host-function paths: `call`, or `pubmed.search`. */
  functions: string[];
  memoryBytes: number;
  cpuMs: number;
  maxCalls: number;
  maxCallBytes: number;
  maxValueBytes: number;
  /** Longest error name, error message or unavailable message, in UTF-16 units. */
  textChars: number;
  /** The layout `logs.ts` reads; keep the two in step. */
  logs: { buffer: SharedArrayBuffer; headBytes: number; ringBytes: number; sliceBytes: number };
}

// Under Node's ESM loader the default import is the variant; the package's types describe its CJS build.
const baseVariant = baseVariantModule as unknown as QuickJSSyncVariant;
const init = workerData as Init;
const port = parentPort;
if (!port) throw new Error("worker.ts runs only as a worker thread");

/** The script's code goes after this on the same line, so line numbers count from its first line. */
const WRAPPER_OPEN = "(async function () {";

// Runs inside QuickJS. `host` and `print` are the only handles to the outside, held in this closure
// so the script cannot reach them. It returns finalize, which the worker calls on the settled
// promise: the result string starts with "r" (the JSON of the returned value) or "t" (the JSON of a
// thrown error's name, message and stack). Everything the prelude uses after the script has run is
// captured here first, because the script can replace any built-in.
const PRELUDE = `(function (host, print, functions, textChars) {
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const toText = String;
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const slice = uncurry(String.prototype.slice);
  const cut = (value) => slice(toText(value), 0, textChars);
  const show = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.name + ": " + value.message;
      if (typeof value === "object" && value !== null) {
        const json = stringify(value);
        if (json !== undefined) return json;
      }
      return toText(value);
    } catch {
      return "[unprintable]";
    }
  };
  const log = (...values) => {
    print(values.map(show).join(" "));
  };
  globalThis.console = { log, info: log, warn: log, error: log };

  const unwrap = (envelope) => {
    const reply = parse(envelope);
    if (reply.ok) return reply.value;
    const error = new Error(reply.message);
    if ("data" in reply) error.data = reply.data;
    throw error;
  };
  const bind = (path) => (...args) => host(path, stringify(args)).then(unwrap);
  for (const path of functions) {
    const dot = path.indexOf(".");
    if (dot < 0) globalThis[path] = bind(path);
    else (globalThis[path.slice(0, dot)] ??= {})[path.slice(dot + 1)] = bind(path);
  }

  // Three JSON strings, one per line. Only strings go through stringify, which never looks for
  // toJSON on them: an object would, and the script can give every object one.
  const describe = (error) => {
    const lines = (name, message, stack) =>
      "t" + stringify(name) + "\\n" + stringify(message) + "\\n" + stringify(stack);
    try {
      if (typeof error === "object" && error !== null)
        return lines(cut(error.name), cut(error.message), cut(error.stack));
      return lines("Error", cut(error), "");
    } catch {
      return lines("Error", "[unprintable]", "");
    }
  };
  return (ok, value) => {
    if (ok) {
      try {
        const json = stringify(value);
        return "r" + (json === undefined ? "null" : json);
      } catch (error) {
        return describe(error);
      }
    }
    return describe(value);
  };
})`;

// QuickJS's own limit does not count everything (twenty thousand 1 KB strings pass an 8 MiB limit),
// so the instance's memory has a hard maximum too: past it the engine's allocation fails and the
// script gets an "out of memory" error at once, not after growing to the 2 GiB default. The
// module's start size (16 MiB) holds its stack and static data; the heap grows from there.
const PAGE_BYTES = 65536;
const INITIAL_PAGES = 256;
const maxPages = Math.max(
  INITIAL_PAGES,
  Math.ceil((init.memoryBytes + 16 * 1024 * 1024) / PAGE_BYTES),
);
const wasmMemory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: maxPages });
const SLICE = init.logs.sliceBytes;
const head = new Uint8Array(init.logs.buffer, 8, init.logs.headBytes);
const ring = new Uint8Array(init.logs.buffer, 8 + init.logs.headBytes, init.logs.ringBytes);
const logTotal = new BigInt64Array(init.logs.buffer, 0, 1);
let logged = 0;

// Writes in slices, each published by raising the total after its bytes are in: ending the worker
// mid-write leaves the buffer readable up to the last total. The ring is one slice longer than the
// tail the reader keeps, so a slice in flight never overwrites a byte it will keep.
function appendLog(text: string): void {
  const bytes = Buffer.from(`${text}\n`);
  for (let from = 0; from < bytes.length; from += SLICE) {
    const slice = bytes.subarray(from, from + SLICE);
    for (let done = 0; done < slice.length; ) {
      const at = logged + done;
      const inHead = at < head.length;
      const target = inHead ? head : ring;
      const offset = inHead ? at : (at - head.length) % ring.length;
      const count = Math.min(slice.length - done, target.length - offset);
      target.set(slice.subarray(done, done + count), offset);
      done += count;
    }
    logged += slice.length;
    Atomics.store(logTotal, 0, BigInt(logged));
  }
}

type Outcome =
  | { type: "done"; kind: "returned"; json: string }
  | { type: "done"; kind: "threw"; name: string; message: string; line?: number; column?: number }
  | { type: "done"; kind: "too_large"; bytes: number }
  | { type: "done"; kind: "timed_out" }
  | { type: "unavailable"; message: string };

const cut = (text: string): string => text.slice(0, init.textChars);

let finished = false;
function finish(outcome: Outcome): void {
  if (finished) return;
  finished = true;
  if (outcome.type === "unavailable") outcome = { ...outcome, message: cut(outcome.message) };
  else if (outcome.kind === "threw")
    outcome = { ...outcome, name: cut(outcome.name), message: cut(outcome.message) };
  port?.postMessage(outcome);
}

/** Position of the first stack frame in the script, counted from the first line of its code. */
function locate(stack: string): { line?: number; column?: number } {
  const match = /script:(\d+):(\d+)/.exec(stack);
  if (!match) return {};
  const line = Number(match[1]);
  const column = Number(match[2]);
  return { line, column: line === 1 ? Math.max(1, column - WRAPPER_OPEN.length) : column };
}

async function main(): Promise<void> {
  const variant = newVariant(baseVariant, { wasmModule: init.wasmModule, wasmMemory });
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime: QuickJSRuntime = quickjs.newRuntime();
  runtime.setMemoryLimit(init.memoryBytes);
  const context: QuickJSContext = runtime.newContext();

  // CPU time is the time spent inside the engine, summed over every entry into it. Waiting on a host
  // call happens outside it, so it is free. The interrupt handler runs only while the engine runs
  // script code, and adds the entry in progress.
  let cpuSpent = 0;
  let entered = 0;
  let overCpu = false;
  runtime.setInterruptHandler(() => {
    if (cpuSpent + (performance.now() - entered) > init.cpuMs) overCpu = true;
    return overCpu;
  });
  function inEngine<T>(enter: () => T): T {
    entered = performance.now();
    try {
      return enter();
    } finally {
      cpuSpent += performance.now() - entered;
      if (overCpu) finish({ type: "done", kind: "timed_out" });
    }
  }

  let calls = 0;
  let nextId = 0;
  const pending = new Map<number, QuickJSDeferredPromise>();
  const refuse = (message: string): QuickJSHandle => {
    const deferred = context.newPromise();
    const envelope = context.newString(JSON.stringify({ ok: false, message }));
    deferred.resolve(envelope);
    envelope.dispose();
    const handle = deferred.handle.dup();
    deferred.dispose();
    return handle;
  };
  const hostHandle = context.newFunction("host", (pathHandle, jsonHandle) => {
    const path = context.getString(pathHandle);
    // `stringify(args)` runs `toJSON`, which the script can replace: only an array is a call.
    if (context.typeof(jsonHandle) !== "string") return refuse("host call arguments are not JSON");
    const json = context.getString(jsonHandle);
    if (!json.startsWith("[")) return refuse("host call arguments are not an array");
    if (++calls > init.maxCalls)
      return refuse(`too many host calls: the limit is ${init.maxCalls}`);
    if (Buffer.byteLength(json) > init.maxCallBytes)
      return refuse(`host call arguments are over the limit of ${init.maxCallBytes} bytes`);
    const id = nextId++;
    const deferred = context.newPromise();
    pending.set(id, deferred);
    port?.postMessage({ type: "call", id, path, args: json });
    return deferred.handle;
  });
  const printHandle = context.newFunction("print", (textHandle) => {
    appendLog(context.getString(textHandle));
  });
  const functionsHandle = context.newArray();
  init.functions.forEach((path, index) => {
    const item = context.newString(path);
    context.setProp(functionsHandle, index, item);
    item.dispose();
  });

  const finalize = inEngine(() => {
    const prelude = context.unwrapResult(context.evalCode(PRELUDE, "prelude"));
    return context.unwrapResult(
      context.callFunction(
        prelude,
        context.undefined,
        hostHandle,
        printHandle,
        functionsHandle,
        context.newNumber(init.textChars),
      ),
    );
  });

  const compiled = inEngine(() => context.evalCode(`${WRAPPER_OPEN}${init.code}\n})`, "script"));
  if (compiled.error) {
    const error = context.dump(compiled.error) as {
      name?: string;
      message?: string;
      stack?: string;
    };
    finish({
      type: "done",
      kind: "threw",
      name: String(error.name ?? "SyntaxError"),
      message: String(error.message),
      ...locate(String(error.stack ?? "")),
    });
    return;
  }

  const started = inEngine(() => context.callFunction(compiled.value, context.undefined));
  if (started.error)
    throw new Error(`script start failed: ${JSON.stringify(context.dump(started.error))}`);
  const promise = started.value;

  // The script's promise is read from the engine, never through `then`, which the script can
  // replace. A promise settles only while jobs run, so this is checked after each pump.
  function settle(): void {
    if (finished) return;
    const state = context.getPromiseState(promise);
    if (state.type === "pending") return;
    const ok = state.type === "fulfilled";
    const outcome = inEngine(() =>
      context.callFunction(
        finalize,
        context.undefined,
        ok ? context.true : context.false,
        ok ? state.value : state.error,
      ),
    );
    // Only running out of memory can fail here: the prelude catches whatever the script's own
    // values throw.
    if (outcome.error) {
      finish({ type: "done", kind: "threw", name: "InternalError", message: "out of memory" });
      return;
    }
    const result = context.getString(outcome.value);
    if (result.startsWith("r")) {
      const bytes = Buffer.byteLength(result) - 1;
      if (bytes > init.maxValueBytes) finish({ type: "done", kind: "too_large", bytes });
      else finish({ type: "done", kind: "returned", json: result.slice(1) });
    } else {
      const [name, message, stack] = result
        .slice(1)
        .split("\n")
        .map((line) => JSON.parse(line) as string);
      finish({ type: "done", kind: "threw", name, message, ...locate(stack) });
    }
  }

  const pump = () => {
    inEngine(() => runtime.executePendingJobs());
    settle();
  };
  pump();

  port?.on("message", (message: { type: "reply"; id: number; envelope: string }) => {
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    try {
      inEngine(() => {
        const envelope = context.newString(message.envelope);
        deferred.resolve(envelope);
        envelope.dispose();
      });
      deferred.dispose();
      pump();
    } catch (error) {
      fail(error);
    }
  });
}

// A trap with the instance's memory full is the script running the engine out of memory, which
// QuickJS can fail to survive; any other failure here is the backend's.
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof WebAssembly.RuntimeError &&
    wasmMemory.buffer.byteLength === maxPages * PAGE_BYTES
  ) {
    finish({ type: "done", kind: "threw", name: "InternalError", message: "out of memory" });
  } else {
    finish({ type: "unavailable", message });
  }
}

main().catch(fail);
