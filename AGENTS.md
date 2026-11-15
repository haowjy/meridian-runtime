# meridian-runtime — Agent Instructions

`@meridian-flow/runtime`: what an AI product needs to run models, as one npm package. Meridian Flow
(`haowjy/meridian-flow`) built it and is its first user; Voluma is the second. The repo root is the
package; each part is a subpath entry with its source in `src/<part>/`:

- `src/gateway` (`./gateway`, `./gateway/shapes`, `./gateway/mock`, `./gateway/mock-script`): one
  streaming port over Anthropic, OpenAI, Gemini and OpenAI-compatible providers. Read its
  [AGENTS.md](src/gateway/AGENTS.md) and [.context](src/gateway/.context/CONTEXT.md) before changing it.
- `./mcp` is planned.

`README.md` is the npm page; keep its example current (`pnpm check:package` typechecks it).

## Rules the package keeps

- **No host knowledge.** The package never reads `process.env` (Biome `noProcessEnv`): keys, URLs
  and policy come in through config or the call. What a product offers, charges or reads from its
  environment stays in that product.
- **The tarball is the product.** `pnpm check:package` packs the package, installs it with plain npm
  into an empty project, imports every entry and typechecks the declarations, again without
  `@types/node` for the entries in `meridianRuntime.nodeFreeEntries`. `exports` point at `dist/`
  only; a new entry goes in `exports`, and in `nodeFreeEntries` if browsers import it. Dependencies
  carry concrete ranges in `package.json` (no workspace, no `catalog:`).
- **Choose the simpler system, fix the root cause, one way per situation.** Same as Flow.

## Build and test

`pnpm install`, then `pnpm check` (Biome, typecheck, tests, the tarball check). CI runs the same.

## Releasing

One version for the whole package, like meridian-cli: tag `v<version>`, one `CHANGELOG.md` at the
root. Releases are automatic: each merge to `main` releases if a PR since the last `v*` tag changed
what ships (`src/`, `package.json`, `README.md`, `LICENSE`); a CI-only or docs-only PR releases
nothing. The labels of those PRs pick the bump, and the strongest one wins (`rc` < `patch` < `minor` < `major`):

| Label                                 | Releases                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `release:patch` (or `release:stable`) | next patch, `latest`                                                      |
| `release:minor` / `release:major`     | next minor / major, `latest`                                              |
| `release:rc`                          | next release candidate, `0.1.1-rc.1`, `-rc.2`, ... on the `next` dist-tag |
| `release:skip`                        | nothing now; its notes go in the next release                             |
| none, unknown, or conflicting labels  | a release candidate                                                       |

A release needs at least one such PR since the last tag that is not `skip`. A stable release after candidates (`release:patch` on top of `0.1.1-rc.2`) is `0.1.1`. Its entry
covers everything since the last stable release.

On a merge, `.github/workflows/release.yml` runs `tools/release.mjs` on the current `main`, not on
the pushed commit: it bumps `version`, renders the `## Changelog` sections of the PRs merged since
the last release into `CHANGELOG.md`, commits `release: v<version>`, tags `v<version>` and pushes
both. If the push is rejected because `main` moved, it starts over from the new `main`. The same
run then checks the repo, packs and checks the tarball (`tools/check-package.mjs`) and publishes it
with provenance (trusted publishing, no token). A last job creates a GitHub Release for every tag
whose version is on npm and has none; a tag that never reached npm gets none. The job holding the
publish token checks out nothing and installs only the pinned npm. A cancelled, late or failed run
loses nothing: the next run releases what is still unreleased, publishes the latest tag if it is
not on npm and creates any missing GitHub Release. Every step is decided from state, so overlapping
runs and reruns are safe: a version already on npm is not published again (and counts as done), and
a Release is made once. A tag push starts no workflow, and a tag pushed with `GITHUB_TOKEN` couldn't
anyway.

`pr-body.yml` fails a non-draft PR without a valid `## Changelog` section, and any PR that edits
`CHANGELOG.md` (the release job owns it). Never bump `version` by hand.

Things to know:

- Two PRs merged close together share one release, on the stronger label.
- The release commit goes straight to `main` with `GITHUB_TOKEN`; `main` must allow that.
- With no `v<version>` tag nothing is released (the run warns): the first version is tagged by hand.
- A release that fails (more than 200 commits since the last tag, several PRs for one commit) is
  reported and the run goes red.
- A squash-merged PR titled `release: ...` is an ordinary change; only the bot's
  `release: v<version>` commits are skipped.

**First version.** npm sets a trusted publisher only on a package that exists, so the first version
is published by hand. `version` is `0.1.0` in `package.json`. Merge that with `release:skip`, then at
the merge commit run `npm login`, `pnpm pack` and `npm publish <tarball> --access public`. Push the
tag `git tag v0.1.0 <merge-sha> && git push origin v0.1.0`. The tag push starts nothing; the next
run on `main` creates its GitHub Release (it is on npm and has none), or run `Release` from the
Actions tab on `main` with the tag to get it at once. On npmjs.com, in the package's settings, add
the trusted publisher: GitHub Actions, repository `haowjy/meridian-runtime`, workflow `release.yml`,
environment `npm`. The next merge that changes what ships releases `0.1.1` (or whatever its label
says) from that tag.

**Publishing an existing tag by hand** (a run failed past recovery, or a backfill): rerun the failed
jobs, or start `Release` from the Actions tab on `main` with the tag name. A tag must be reachable
from `main` and match its `package.json` version. The `npm` environment allows deployments from
`main` only, so nothing publishes from a tag push or from another branch.

## Git

Work on a branch and open a PR; `main` takes PRs only. The PR body's `## Changelog` section says
what changed for a consumer. Any model may merge a reviewed PR with green CI.

## Trying a change in Flow before it is published

To run your checkout in Flow's dev stack (pnpm 10.34; use the Flow checkout that is yours):

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
