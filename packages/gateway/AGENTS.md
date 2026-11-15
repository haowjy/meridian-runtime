# @meridian-flow/gateway

The model gateway. Rationale and policy: [`.context/CONTEXT.md`](.context/CONTEXT.md).

- Never read `process.env` (Biome `noProcessEnv`): credentials come in through `ProviderConfig.auth`
  or `GenerateRequest.auth` ([credentials](.context/CONTEXT.md#credentials)). The SDKs read the environment for any option left unset (`*_API_KEY`,
  `*_BASE_URL`, `*_AUTH_TOKEN`, ...): `providerClientOptions` passes each explicitly (a token adds `apiKey: null`/`authToken: null` on Anthropic), so a new SDK
  option that defaults from `process.env` needs the same (`*_CUSTOM_HEADERS` has no opt-out).
- `./shapes` must stay free of Node built-ins and SDKs, and imports only its own files: Flow's
  browser bundle imports it through `@meridian/contracts`. Biome enforces the imports;
  `pnpm check:packages` typechecks `.` and `./shapes` without `@types/node`. The mock server
  (`node:http`) is only reachable from `./mock`.
- What a product offers and charges (its model registry and prices) stays in that product; Flow's
  is `apps/server/server/lib/gateway/` there.

## Trying a change in Flow before it is published

Flow depends on `@meridian-flow/gateway` from npm. To run your checkout in Flow's dev stack
(pnpm 10.34; use the Flow checkout that is yours):

1. Here, `pnpm install`, then `pnpm --filter @meridian-flow/gateway dev` (`tsc --watch` into `dist/`,
   which is all Flow reads). Leave it running.
2. In Flow's `pnpm-workspace.yaml`, under `overrides:`, add
   `"@meridian-flow/gateway": link:<absolute path to this checkout>/packages/gateway`, then `pnpm install`.
   Flow's `node_modules/@meridian-flow/gateway` is now a symlink to this package.
3. Flow's server does not reload a linked package: after a change here has compiled, run
   `pnpm dev --restart` in Flow. (`LIVE_TEST_MODEL=` and `MODEL_PROVIDER=mock` as that run needs.)
4. When done, stop the watcher and in Flow run
   `git checkout pnpm-workspace.yaml pnpm-lock.yaml && pnpm install`.
   A `link:` left in a commit fails CI's frozen install, because the path does not exist there.

Releases bump `version` (see the root `AGENTS.md`); then move Flow's catalog entry
(`'@meridian-flow/gateway'` in `pnpm-workspace.yaml`) to the new version.
