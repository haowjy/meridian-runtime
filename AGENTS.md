# meridian-runtime — Agent Instructions

The packages an AI product needs to run models, published to npm one by one. Meridian Flow
(`haowjy/meridian-flow`) built them and is their first user; Voluma is the second. Each package lives
under `packages/` with its own version, changelog section and `AGENTS.md`:

- `packages/gateway` (`@meridian-flow/gateway`): one streaming port over Anthropic, OpenAI, Gemini
  and OpenAI-compatible providers.

## Rules every package keeps

- **No host knowledge.** A package never reads `process.env` (Biome `noProcessEnv`): keys, URLs and
  policy come in through config or the call. What a product offers, charges or reads from its
  environment stays in that product.
- **The tarball is the product.** `pnpm check:packages` packs each public package, installs it with
  plain npm into an empty project, imports every entry and typechecks the declarations, again
  without `@types/node` for the entries in `meridianRuntime.nodeFreeEntries`. `exports` point at
  `dist/` only; a new entry goes in `exports`, and in `nodeFreeEntries` if browsers import it.
- **Choose the simpler system, fix the root cause, one way per situation.** Same as Flow.

## Build and test

`pnpm install`, then `pnpm check` (Biome, typecheck, tests, the tarball check). CI runs the same.

## Releasing

Bump `version` in the package's `package.json` in its PR (semver; a pre-release such as
`0.3.0-rc.1` goes to the `next` dist-tag). When the PR merges, `.github/workflows/publish.yml`
packs and checks every package whose version is not on npm yet, publishes it with provenance
(trusted publishing, no token), and pushes the tag `<package-dir>-v<version>` (for example
`gateway-v0.2.0`). The job holding the publish token installs nothing. A version already on npm is
skipped, so re-running is safe.

A new package's first version is published by hand, because npm sets a trusted publisher only on a
package that exists: `npm login`, then in the package directory `pnpm pack` and
`npm publish <tarball> --access public`. Then on npmjs.com, in the package's settings, add the
trusted publisher: GitHub Actions, repository `haowjy/meridian-runtime`, workflow `publish.yml`,
environment `npm`. The next run of `publish.yml` tags the hand-published version.

## Git

Work on a branch and open a PR; `main` takes PRs only. The PR body's `## Changelog` section says
what changed for a consumer. Any model may merge a reviewed PR with green CI.

## Using a change from Flow before it is published

See `packages/gateway/AGENTS.md`.
