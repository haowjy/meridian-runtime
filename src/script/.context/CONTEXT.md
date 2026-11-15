# Script

A **script** is JavaScript a model wrote: the body of an async function that calls functions the
host hands it (`globals`) and returns one JSON value. It has no files, network, timers, `import` or
`process`; its only reach is the host functions. `ScriptRunner.run` turns every outcome into a
`ScriptResult` the host shows the model (`returned`, `threw`, `timed_out`, `too_large`, `aborted`,
`unavailable`) and never throws for what the script did. A script's calls can have effects, so no
result kind is retried. The first user is MCP code mode in Meridian Flow. A sandbox (a Linux
machine) is a different port, not built here.

## The QuickJS runner

`createQuickJsRunner` runs each script in QuickJS compiled to WebAssembly (`quickjs-emscripten-core`
with `@jitl/quickjs-wasmfile-release-sync`, both pinned: take their updates as security updates), in
its own worker thread with an empty environment. Each run gets a new thread and a new instance of
a module compiled once per runner; nothing is kept between runs. The runner needs Node 22 or later
and worker threads; it does not run in workerd.

**Why a thread.** QuickJS runs a script to its next `await` without yielding, so a loop would hold the
host's one event loop. The thread keeps the host's timers on time.

**What the worker bounds before it sends.** A thread protects the host from a loop that computes,
not from one that prints or calls, since each message costs the host work. So:

- Logs go into a `SharedArrayBuffer` (`logs.ts`): the first half of `maxLogBytes`, and a ring of the
  latest half. The host reads it after the worker is ended, even mid-write: the worker raises the
  printed-bytes count only after a slice is in, and the ring is one slice longer than the tail
  kept. Nothing is posted per line.
- The worker counts calls and measures each call's arguments, and fails a call past `maxCalls` or
  `maxCallBytes` inside the script, without posting.
- `cpuMs` is the time spent inside the engine, summed over every entry into it (`inEngine`). The
  interrupt handler runs while script code runs and adds the entry in progress. Waiting on a host
  call is outside the engine, so it is free. A builtin that never polls the handler (a long
  `repeat`, a big sort) is bounded by the wall limit.
- The returned value is stringified in the script and its size checked before it is posted.

**Wall time and abort are the host ending the thread** (`worker.terminate()`), so they hold whatever
the engine is doing. The host function signals fire first. A run past `maxConcurrent` waits for a
slot; the wait is not part of `wallMs`.

**Memory has two walls, and QuickJS's own is not enough.** `setMemoryLimit` does not count
everything (twenty thousand 1 KB strings pass an 8 MiB limit). The instance's
`WebAssembly.Memory` therefore has a hard `maximum` of `memoryBytes` plus 16 MiB (the module's own
stack and static data), so a runaway allocation fails in about 0.4 s as
`InternalError: out of memory` in the script. The engine does not always survive a failed
allocation and may trap; a trap with the memory at its maximum is reported as that same `threw`
(`fail` in `worker.ts`), any other trap as `unavailable`. A worker's `resourceLimits` bound only
its JavaScript heap, but without a small young generation each worker let garbage reach 240 MiB
before a collection; the runner sets both.

**A run's memory** is about `memoryBytes` plus 10 to 15 MiB (isolate, module start size, buffers).

## Gotchas

- Attach `resolvePromise` to the script's promise before the first `executePendingJobs`, or a script
  that makes no host call never settles.
- Everything the worker runs through the engine is inside `inEngine`; code outside it that reaches
  the interrupt handler measures from a stale start and times the script out at once.
- The script's code goes after the wrapper's opening on the same line, so `line` counts from the
  first line of `code`; only line 1's `column` needs the wrapper's width taken off.
- Importing `quickjs-emscripten-core`'s `newQuickJSWASMModule` or the umbrella package pulls four
  `.wasm` files; this runner uses one variant.
