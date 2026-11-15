import type { ScriptRequest, ScriptResult, ScriptRunner } from "../index.js";

/** What one `run` of the fake does: a canned result, or a function that makes one. */
export type FakeScriptStep =
  | ScriptResult
  | ((request: ScriptRequest, signal?: AbortSignal) => ScriptResult | Promise<ScriptResult>);

export interface FakeScriptRunner extends ScriptRunner {
  /** Every request `run` got, in order. */
  readonly requests: ScriptRequest[];
}

export const noLogs = { text: "", cutBytes: 0 } as const;

/**
 * A `ScriptRunner` for a product's own tests. Run `n` does step `n`; a run past the last step
 * rejects, which fails a test that runs more scripts than it planned. A step can call
 * `request.globals` itself to exercise the host functions the way a real runner would.
 */
export function createFakeScriptRunner(steps: FakeScriptStep[]): FakeScriptRunner {
  const requests: ScriptRequest[] = [];
  return {
    requests,
    async run(request, signal) {
      const step = steps[requests.length];
      requests.push(request);
      if (step === undefined)
        throw new Error(`the fake script runner has no step ${requests.length}`);
      return typeof step === "function" ? step(request, signal) : step;
    },
    async close() {},
  };
}
