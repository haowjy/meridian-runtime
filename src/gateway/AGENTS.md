# Gateway (`@meridian-flow/runtime/gateway`)

The model gateway. Rationale and policy: [`.context/CONTEXT.md`](.context/CONTEXT.md).

- Never read `process.env` (Biome `noProcessEnv`): credentials come in through `ProviderConfig.auth`
  or `GenerateRequest.auth` ([credentials](.context/CONTEXT.md#credentials)). The SDKs read the environment for any option left unset (`*_API_KEY`,
  `*_BASE_URL`, `*_AUTH_TOKEN`, ...): `providerClientOptions` passes each explicitly (a token adds `apiKey: null`/`authToken: null` on Anthropic), so a new SDK
  option that defaults from `process.env` needs the same (`*_CUSTOM_HEADERS` has no opt-out).
- `shapes/` (the `./gateway/shapes` entry) must stay free of Node built-ins and SDKs, and imports only
  its own files: Flow's browser bundle imports it through `@meridian/contracts`. Biome enforces the
  imports; `pnpm check:package` typechecks `./gateway` and `./gateway/shapes` without `@types/node`.
  The mock server (`node:http`) is only reachable from `./gateway/mock`.
- What a product offers and charges (its model registry and prices) stays in that product; Flow's
  is `apps/server/server/lib/gateway/` there.
