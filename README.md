# @meridian-flow/runtime

What an AI product needs to run language models, as one npm package. Meridian Flow built it and is
its first user. Today it holds the model gateway; each part is its own subpath entry.

```sh
npm install @meridian-flow/runtime
```

Node 20 or newer, ESM only.

## Entries

| Entry                                        | What it is                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@meridian-flow/runtime/gateway`             | One streaming `Gateway` over Anthropic, OpenAI, Gemini and OpenAI-compatible providers: retries, deadlines, usage normalization and a credential per call.                 |
| `@meridian-flow/runtime/gateway/shapes`      | The gateway's usage, provider-error and JSON types. No Node built-ins and no SDKs, so a browser bundle can import them.                                                    |
| `@meridian-flow/runtime/gateway/mock`        | A mock provider server for tests and local development (needs `node:http`).                                                                                                |
| `@meridian-flow/runtime/gateway/mock-script` | The zod schemas of the mock's scripts.                                                                                                                                     |
| `@meridian-flow/runtime/mcp`                 | A client for MCP servers over stdio and Streamable HTTP: list, call and check, with replies read off the wire, plus pure functions that pin tools for a model. Needs Node. |
| `@meridian-flow/runtime/script`              | The script port: JavaScript a model wrote, run once with host functions, returning one JSON value. No Node built-ins.                                                      |
| `@meridian-flow/runtime/script/quickjs`      | `createQuickJsRunner`: runs a script in QuickJS compiled to WebAssembly, in a worker thread (Node 22 or newer).                                                            |
| `@meridian-flow/runtime/script/testing`      | The conformance suite every script runner passes, and a scripted fake runner (needs `vitest`).                                                                             |

The package reads no environment variable: keys, URLs and policy come in through config or the call.

## Example

A gateway with one provider and a credential chosen per call. The model row (limits, input
kinds, reasoning efforts, cache lifetimes) is yours to declare; this one follows
[models.dev](https://models.dev) for Claude Sonnet 5.5.

```ts
import { createGateway, user } from "@meridian-flow/runtime/gateway";

const gateway = createGateway({
  providers: [
    {
      id: "anthropic",
      adapter: "anthropic",
      models: [
        {
          id: "claude-sonnet-5-5",
          provider: "anthropic",
          displayName: "Claude Sonnet 5.5",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          tokenizer: "anthropic",
          inputModalities: ["text", "image", "pdf"],
          reasoning: { efforts: ["low", "medium", "high", "max"] },
          promptCache: { kind: "explicit", shortTtlSeconds: 300, longTtlSeconds: 3600 },
        },
      ],
    },
  ],
});

const apiKey = "key-for-this-tenant"; // read it wherever your product keeps keys

for await (const event of gateway.stream({
  model: "claude-sonnet-5-5",
  messages: [user("Say hello.")],
  promptCacheRetention: "none",
  auth: { anthropic: { apiKey } },
})) {
  if (event.type === "text.delta") process.stdout.write(event.text);
}
```

`auth` is keyed by provider id and replaces that provider's own credential for this call only.
Instead of `{ apiKey }`, a credential can be `{ accessToken }`, a function that returns a token
and its expiry.

Licensed under [Apache-2.0](LICENSE).
