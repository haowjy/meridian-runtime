// The only file in src/mcp that may import the gateway: it checks the two stay structurally
// compatible, so a host can hand `toTools` and `toContent` output straight to the gateway.
import { expectTypeOf, test } from "vitest";
import type { MediaPart, TextPart, Tool } from "../gateway/domain/types.js";
import type { ContentPart, ToolDefinition } from "./types.js";

test("package types are assignable to the gateway's", () => {
  expectTypeOf<ToolDefinition>().toExtend<Tool>();
  expectTypeOf<ContentPart>().toExtend<TextPart | MediaPart>();
});
