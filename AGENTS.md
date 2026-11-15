# meridian-runtime — Agent Instructions

`@meridian-flow/runtime`: what an AI product needs to run models, as one npm package. Meridian Flow
(`haowjy/meridian-flow`) built it and is its first user; Voluma is the second. The repo root is the
package; each part is a subpath entry with its source in `src/<part>/`:

- `src/gateway` (`./gateway`, `./gateway/shapes`, `./gateway/mock`, `./gateway/mock-script`): one
  streaming port over Anthropic, OpenAI, Gemini and OpenAI-compatible providers. Read its
  [AGENTS.md](src/gateway/AGENTS.md) and
  [.context](src/gateway/.context/CONTEXT.md) before changing it.
- `src/mcp` (`./mcp`): a client for MCP servers over stdio and Streamable HTTP, with the pure
  functions that pin a server's tools and turn them and replies into what a model reads. Imports
  nothing from the gateway. Read its [AGENTS.md](src/mcp/AGENTS.md) and
  [.context](src/mcp/.context/CONTEXT.md) before changing it.
- `src/script` (`./script`, `./script/quickjs`, `./script/testing`): the script port (JavaScript a
  model wrote, run once with host functions) and a QuickJS-in-WebAssembly runner in a worker
  thread. Read its [AGENTS.md](src/script/AGENTS.md) and
  [.context](src/script/.context/CONTEXT.md) before changing it.

`README.md` is the npm page; keep its example true to the API and to real model facts
(`pnpm check:package` typechecks it).

## Rules the package keeps

- **No host knowledge.** The package never reads `process.env` (Biome `noProcessEnv`): keys, URLs
  and policy come in through config or the call. What a product offers, charges or reads from its
  environment stays in that product.
- **The tarball is the product.** `pnpm check:package` packs the package, installs it with plain npm
  into an empty project, imports every entry and typechecks the declarations, again without
  `@types/node` for the entries in `meridianRuntime.nodeFreeEntries`. `exports` point at `dist/`
  only; a new entry goes in `exports`, and in `nodeFreeEntries` if browsers import it. Dependencies
  carry concrete ranges in `package.json` (no workspace, no `catalog:`).
- **Choose the simpler system, not the smaller change.** When a case doesn't fit, change the design
  instead of adding a branch or flag. Fix the cause of a problem, not where it showed up. Do one
  thing one way, and delete what a change leaves dead.

## Build and test

`pnpm install`, then `pnpm check` (Biome, typecheck, tests, the tarball check). CI runs the same.

## Releasing

One version for the whole package: tag `v<version>`, one `CHANGELOG.md` at the root. Never bump
`version` by hand.

**What triggers a release.** Each merge to `main` releases if a PR since the last `v*` tag changed
what ships: `src/` except tests, `.context/` and `AGENTS.md`, plus `tsconfig.json`,
`tsconfig.build.json`, `package.json`, `README.md` and `LICENSE` (`SHIPPED` in `tools/release.mjs`).
A CI-only or docs-only PR releases nothing. The strongest `release:*` label among those PRs picks
the bump (`rc` < `patch` < `minor` < `major`):

| Label                                 | Releases                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `release:patch` (or `release:stable`) | next patch, `latest`                                                      |
| `release:minor` / `release:major`     | next minor / major, `latest`                                              |
| `release:rc`                          | next release candidate, `0.1.1-rc.1`, `-rc.2`, ... on the `next` dist-tag |
| `release:skip`                        | nothing now; its notes go in the next release                             |
| none, unknown, or conflicting labels  | a release candidate                                                       |

At least one PR since the last tag must not be `skip`. A stable release after candidates
(`release:patch` on top of `0.1.1-rc.2`) is `0.1.1`, and its entry covers everything since the last
stable release. Two PRs merged close together share one release.

**What the workflow does.** `.github/workflows/release.yml` runs `tools/release.mjs` on the current
`main`, not on the pushed commit:

1. `tag` bumps `version`, renders the `## Changelog` sections of the merged PRs into
   `CHANGELOG.md`, commits `release: v<version>`, tags it and pushes both to `main` with
   `GITHUB_TOKEN` (`main` must allow that). If the push is rejected because `main` moved, it starts
   over from the new `main`.
2. `verify` checks the repo, then packs and checks the tarball (`tools/check-package.mjs`).
3. `publish` publishes that tarball with provenance (trusted publishing, no token). It checks out
   nothing and installs only the pinned npm.
4. `github-releases` creates a GitHub Release for every tag that has none and is on npm, or that `publish` just published in this run (the registry can lag a publish by minutes).

Every step is decided from state, so a cancelled, late, failed or overlapping run loses nothing:
the next run releases what is still unreleased, publishes the latest tag if it is not on npm, and
creates any missing Release. A version already on npm is not published again. A release that fails
(more than 200 commits since the last tag, several PRs for one commit) is reported and the run goes
red. A squash-merged PR titled `release: ...` is an ordinary change; only the bot's
`release: v<version>` commits are skipped. A tag push starts no workflow.

`pr-body.yml` fails a non-draft PR without a valid `## Changelog` section, and any PR that edits
`CHANGELOG.md`.

**Publishing a tag by hand** (a run failed past recovery, or a backfill): rerun the failed jobs, or
start `Release` from the Actions tab on `main` with the tag name. The tag must be reachable from
`main` and match its `package.json` version. The `npm` environment allows deployments from `main`
only, so nothing publishes from a tag push or another branch.

**If the tags are lost.** With no `v<version>` tag nothing is released (the run warns). Tag the
commit that set the current `version` (`git tag v<version> <sha> && git push origin v<version>`),
and run `Release` with that tag if its GitHub Release is needed at once.

**A new npm package name.** npm sets a trusted publisher only on a package that exists, so publish
its first version by hand (`npm login`, `pnpm pack`, `npm publish <tarball> --access public`). Then,
on npmjs.com in the package's settings, add the trusted publisher: GitHub Actions, this repository,
workflow `release.yml`, environment `npm`.

## Git

Work on a branch and open a PR; `main` takes PRs only. The PR body's `## Changelog` section says
what changed for a consumer. Any model may merge a reviewed PR with green CI.

## Trying a change in Flow before it is published

To run your checkout in Flow's dev stack (with the pnpm Flow pins in its `packageManager`; use the Flow checkout that is yours):

1. Here, `pnpm install`, then `pnpm dev` (`tsc --watch` into `dist/`, which is all Flow reads).
   Leave it running.
2. In Flow's `pnpm-workspace.yaml`, under `overrides:`, add
   `"@meridian-flow/runtime": link:<absolute path to this checkout>`, then `pnpm install`.
   Flow's `node_modules/@meridian-flow/runtime` is now a symlink to this checkout.
3. Flow's server does not reload a linked package: after a change here has compiled, run
   `pnpm dev --restart` in Flow. (`LIVE_TEST_MODEL=` and `MODEL_PROVIDER=mock` as that run needs.)
4. When done, stop the watcher and in Flow run
   `git checkout pnpm-workspace.yaml pnpm-lock.yaml && pnpm install`.
   A `link:` left in a commit fails CI's frozen install, because the path does not exist there.

Releases bump `version`; then move Flow's catalog entry (`'@meridian-flow/runtime'` in
`pnpm-workspace.yaml`) to the new version.
