# @meridian-flow/runtime

What an AI product needs to run language models, as one npm package. Meridian Flow built it and is
its first user. Today it holds the model gateway; each part is its own subpath entry.

```sh
npm install @meridian-flow/runtime
```

Node 20 or newer, ESM only.

## Entries

| Entry                                        | What it is                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@meridian-flow/runtime/gateway`             | One streaming `Gateway` over Anthropic, OpenAI, Gemini and OpenAI-compatible providers: retries, deadlines, usage normalization and a credential per call. |
| `@meridian-flow/runtime/gateway/shapes`      | The gateway's usage, provider-error and JSON types. No Node built-ins and no SDKs, so a browser bundle can import them.                                    |
| `@meridian-flow/runtime/gateway/mock`        | A mock provider server for tests and local development (needs `node:http`).                                                                                |
| `@meridian-flow/runtime/gateway/mock-script` | The zod schemas of the mock's scripts.                                                                                                                     |

The package reads no environment variable: keys, URLs and policy come in through config or the call.

## Example

A gateway with one provider and a credential chosen per call:

```ts
import { createGateway, user } from "@meridian-flow/runtime/gateway";

const gateway = createGateway({
  providers: [
    {
      id: "anthropic",
      adapter: "anthropic",
      models: [
        {
          id: "claude-sonnet-4-5",
          provider: "anthropic",
          displayName: "Claude Sonnet 4.5",
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
          tokenizer: "anthropic",
          inputModalities: ["text", "image"],
          reasoning: { efforts: ["low", "medium", "high"], canDisable: true },
          promptCache: { kind: "explicit", shortTtlSeconds: 300, longTtlSeconds: 3600 },
        },
      ],
    },
  ],
});

const apiKey = "key-for-this-tenant"; // read it wherever your product keeps keys

for await (const event of gateway.stream({
  model: "claude-sonnet-4-5",
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
