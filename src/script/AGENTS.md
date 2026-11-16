# Script (`@meridian-flow/runtime/script`)

Model-written JavaScript run once with a set of host functions, returning one JSON value. Rationale
and the QuickJS runner's mechanics: [`.context/CONTEXT.md`](.context/CONTEXT.md).

- Entries: `./script` (`index.ts`: the types and `HostFunctionError`; no Node built-ins, listed in
  `nodeFreeEntries`), `./script/quickjs` (`quickjs/`: `createQuickJsRunner`), `./script/testing`
  (`testing/`: the conformance suite and a scripted fake runner; `vitest` is an optional peer).
- Imports nothing from `src/gateway` or `src/mcp`, and never reads `process.env`.
- `quickjs/worker.ts` imports nothing relative: the runner loads it as `worker.ts` when it runs
  from source (tests, Node's type stripping) and as `worker.js` from the package, and a bundler
  must not have to follow an import out of it. Keep it to erasable TypeScript (no enums, no
  parameter properties). `quickjs/logs.ts` is the reader of the log buffer the worker writes; change
  the two together.
- A host that bundles its server must leave this package external (Nitro: `traceDeps`), or the
  worker and the `.wasm` file are not found and every run is `unavailable`.
- A new backend passes `describeScriptRunner` (`testing/conformance.ts`), one case per promise
  under "What `run` promises the host". Add the case with the promise.
