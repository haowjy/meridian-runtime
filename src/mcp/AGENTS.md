# MCP client (`@meridian-flow/runtime/mcp`)

A client for MCP servers over stdio and Streamable HTTP. Rationale and the rules for outcomes:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

- Never read `process.env` (Biome `noProcessEnv`). One exception sits in the SDK: its stdio
  transport copies six variables from the host process into the child (`HOME`, `LOGNAME`, `PATH`,
  `SHELL`, `TERM`, `USER`), and no option turns that off. The host's `env` is added on top and wins.
  Every other SDK option that could default from the environment or a global is passed explicitly
  (`fetch`, `redirectPolicy`, `versionNegotiation`, `capabilities`, the stdio `stderr` and
  `maxBufferSize`). A new SDK option needs the same.
- No SDK type in a public type (`types.ts`). Only `session.ts`, `fault.ts` and `client.ts` import
  the SDK.
- Imports nothing from `src/gateway`. `gateway-types.test.ts` is the one file that does, to check
  `ToolDefinition` and `ContentPart` stay assignable to the gateway's `Tool`, `TextPart` and
  `MediaPart`.
- Never set the SDK's `redirectPolicy: "follow"`: `fetch` would then carry the token and custom
  headers to another origin.
- The outcome of a call comes from the raw JSON-RPC message, never from what `callTool` returned
  or threw. `client.test.ts` guards the reply matching that depends on an SDK internal: run it on
  every SDK upgrade.
- `testing/` is test support (a purpose-built server over HTTP and stdio) and is not built.
