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

Releases are per package and automatic: merging a PR releases each package whose files it changed
(`packages/<dir>/`); a PR that changes no package releases nothing. The PR's label picks the bump:

| Label                                 | Releases                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `release:patch` (or `release:stable`) | next patch, `latest`                                                      |
| `release:minor` / `release:major`     | next minor / major, `latest`                                              |
| `release:rc`                          | next release candidate, `0.1.1-rc.1`, `-rc.2`, ... on the `next` dist-tag |
| `release:skip`                        | nothing now; its notes go in the package's next release                   |
| none, unknown, or conflicting labels  | a release candidate                                                       |

A stable release after candidates (`release:patch` on top of `0.1.1-rc.2`) is `0.1.1`. Its entry
covers everything since the last stable release.

On the merge, `.github/workflows/release.yml` runs `tools/release.mjs`: it bumps each package's
`version`, renders the `## Changelog` sections of the PRs merged since the package's last release
into `packages/<dir>/CHANGELOG.md`, commits `release: <dir>-v<version>` (body line
`Release-Trigger: <merge sha>`), tags `<dir>-v<version>` and pushes both. The same run then checks
the repo, packs and checks the tarball (`tools/check-package.mjs`), publishes it with provenance
(trusted publishing, no token) and creates the GitHub Release. The job holding the publish token
checks out and installs nothing. Rerunning the workflow is safe: a trigger already released is not
released twice, a missing tag is recreated, a version already on npm is not published again.
A tag pushed with `GITHUB_TOKEN` starts no workflow, which is why tagging and publishing are one run.

`pr-body.yml` fails a non-draft PR without a valid `## Changelog` section, and any PR that edits a
`CHANGELOG.md` (the release job owns them). Never bump a `version` by hand.

Things to know:

- One release per package per merge, on the merged PR's label. If two PRs merge before the first
  run starts, the first run's release includes both and the second finds nothing left to release.
- The release commit goes straight to `main` with `GITHUB_TOKEN`; `main` must allow that.
- The run fails for a package with no `<dir>-v<version>` tag: first versions are tagged by hand.

**First version of a new package.** npm sets a trusted publisher only on a package that exists, so
the first version is published by hand. Set `version` in its `package.json` (for example `0.1.0`),
merge that with `release:skip`, then at the merge commit run `npm login`, `pnpm pack` in the
package directory and `npm publish <tarball> --access public`. Push the tag
`git tag <dir>-v0.1.0 <merge-sha> && git push origin <dir>-v0.1.0`: the tag push starts
`release.yml`, which sees the version on npm, publishes nothing and creates the GitHub Release.
On npmjs.com, in the package's settings, add the trusted publisher: GitHub Actions, repository
`haowjy/meridian-runtime`, workflow `release.yml`, environment `npm`. The next merge that changes
the package releases `0.1.1` (or whatever its label says) from that tag.

**Publishing an existing tag by hand** (a run failed past recovery, or a backfill): rerun the failed
jobs, or start `Release` from the Actions tab with the tag name. A tag must be reachable from
`main` and match its `package.json` version.

## Git

Work on a branch and open a PR; `main` takes PRs only. The PR body's `## Changelog` section says
what changed for a consumer. Any model may merge a reviewed PR with green CI.

## Using a change from Flow before it is published

See `packages/gateway/AGENTS.md`.
