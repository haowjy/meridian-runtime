# Gateway (`@meridian-flow/runtime/gateway`)

The model gateway. Rationale and policy: [`.context/CONTEXT.md`](.context/CONTEXT.md).

- Never read `process.env` (Biome `noProcessEnv`): credentials come in through `ProviderConfig.auth`
  or `GenerateRequest.auth` ([credentials](.context/CONTEXT.md#credentials)). The SDKs read the
  environment for any client option left unset (`*_API_KEY`, `*_BASE_URL`, `*_AUTH_TOKEN`, ...), so
  each adapter passes every such option explicitly: `providerClientOptions` sets the shared ones,
  and `ANTHROPIC_ENV_OPTOUT` / `OPENAI_ENV_OPTOUT` (`adapters/provider-http-error.ts`) set the
  rest to `null` (`false` for Anthropic's `openTelemetry`). The Anthropic adapter always passes `authToken: null`; its `apiKey` is the
  caller's key, or a placeholder when the credential is a token (`adapters/credentials.ts`). A new
  SDK option that defaults from `process.env` needs the same (`*_CUSTOM_HEADERS` has no opt-out).
- `shapes/` (the `./gateway/shapes` entry) must stay free of Node built-ins and SDKs, and imports
  only its own files, so a host's browser bundle can import it. Biome enforces the imports;
  `pnpm check:package` typechecks `./gateway` and `./gateway/shapes` without `@types/node`. The
  mock server (`node:http`) is only reachable from `./gateway/mock`.
- What a product offers and charges (its model list and prices) stays in that product. See
  [Package boundary](.context/CONTEXT.md#package-boundary) for a host's example.
