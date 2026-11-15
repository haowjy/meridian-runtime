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

Releases are per package and automatic: each merge to `main` releases every package with changes
(`packages/<dir>/`) since its last `<dir>-v*` tag. The labels of the PRs that made those changes
pick the bump, and the strongest one wins (`rc` < `patch` < `minor` < `major`):

| Label                                 | Releases                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `release:patch` (or `release:stable`) | next patch, `latest`                                                      |
| `release:minor` / `release:major`     | next minor / major, `latest`                                              |
| `release:rc`                          | next release candidate, `0.1.1-rc.1`, `-rc.2`, ... on the `next` dist-tag |
| `release:skip`                        | nothing now; its notes go in the package's next release                   |
| none, unknown, or conflicting labels  | a release candidate                                                       |

A release needs at least one PR since the last tag that is not `skip`. A stable release after candidates (`release:patch` on top of `0.1.1-rc.2`) is `0.1.1`. Its entry
covers everything since the last stable release.

On a merge, `.github/workflows/release.yml` runs `tools/release.mjs` on the current `main`, not on
the pushed commit: it bumps each such package's `version`, renders the `## Changelog` sections of
the PRs merged since its last release into `packages/<dir>/CHANGELOG.md`, commits
`release: <dir>-v<version>`, tags `<dir>-v<version>` and pushes both. If the push is rejected
because `main` moved, it starts over from the new `main`. The same run then checks
the repo, packs and checks the tarball (`tools/check-package.mjs`) and publishes it with provenance
(trusted publishing, no token). A last job creates a GitHub Release for every tag whose version is on
npm and has none; a tag that never reached npm gets none. The job holding the publish token
checks out nothing and installs only the pinned npm. A cancelled, late or failed run loses nothing:
the next run releases what is still unreleased, publishes any latest tag not on npm and creates any
missing GitHub Release. Every step is decided from state, so overlapping runs and reruns are safe: a
version already on npm is not published again (and counts as done), and a Release is made once.
A tag push starts no workflow, and a tag pushed with `GITHUB_TOKEN` couldn't anyway.

`pr-body.yml` fails a non-draft PR without a valid `## Changelog` section, and any PR that edits a
`CHANGELOG.md` (the release job owns them). Never bump a `version` by hand.

Things to know:

- Two PRs merged close together share one release, on the stronger label.
- The release commit goes straight to `main` with `GITHUB_TOKEN`; `main` must allow that.
- A package with no `<dir>-v<version>` tag is not released (the run warns): first versions are
  tagged by hand.
- A package that fails (more than 200 commits since its last tag, several PRs for one commit) is
  reported and the run goes red, but the other packages still release.
- A squash-merged PR titled `release: ...` is an ordinary change; only the bot's
  `release: <dir>-v<version>` commits are skipped.

**First version of a new package.** npm sets a trusted publisher only on a package that exists, so
the first version is published by hand. Set `version` in its `package.json` (for example `0.1.0`),
merge that with `release:skip`, then at the merge commit run `npm login`, `pnpm pack` in the
package directory and `npm publish <tarball> --access public`. Push the tag
`git tag <dir>-v0.1.0 <merge-sha> && git push origin <dir>-v0.1.0`. The tag push starts nothing; the
next run on `main` creates its GitHub Release (it is on npm and has none), or run `Release` from the
Actions tab on `main` with the tag to get it at once.
On npmjs.com, in the package's settings, add the trusted publisher: GitHub Actions, repository
`haowjy/meridian-runtime`, workflow `release.yml`, environment `npm`. The next merge that changes
the package releases `0.1.1` (or whatever its label says) from that tag.

**Publishing an existing tag by hand** (a run failed past recovery, or a backfill): rerun the failed
jobs, or start `Release` from the Actions tab on `main` with the tag name. A tag must be reachable
from `main` and match its `package.json` version. The `npm` environment allows deployments from
`main` only, so nothing publishes from a tag push or from another branch.

## Git

Work on a branch and open a PR; `main` takes PRs only. The PR body's `## Changelog` section says
what changed for a consumer. Any model may merge a reviewed PR with green CI.

## Using a change from Flow before it is published

See `packages/gateway/AGENTS.md`.
