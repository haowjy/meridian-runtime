import { afterEach, vi } from "vitest";
import { describeScriptRunner } from "../testing/index.js";
import { createQuickJsRunner } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describeScriptRunner("QuickJS in a worker thread", () => createQuickJsRunner(), {
  unavailable: () => {
    vi.spyOn(WebAssembly, "compile").mockRejectedValueOnce(new Error("the wasm would not load"));
    return createQuickJsRunner();
  },
});
