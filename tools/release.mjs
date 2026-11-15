#!/usr/bin/env node
// The release process's steps, run by .github/workflows/release.yml and pr-body.yml.
//
//   release              (push to main) release each package the merged PR changed: bump its
//                        version, render its CHANGELOG.md, commit `release: <dir>-v<version>`,
//                        tag `<dir>-v<version>`, push. Writes `tags=[...]` to $GITHUB_OUTPUT.
//   resolve <tags>       check each tag (a JSON array or one tag) and write `releases` (all) and
//                        `unpublished` (not on npm yet) to $GITHUB_OUTPUT as JSON.
//   notes <tag>          print the tag's CHANGELOG.md entry (the GitHub Release body).
//   validate-pr <body-file> <base-ref>
//                        the PR body has a valid `## Changelog` and no CHANGELOG.md is edited.
//
// Env for `release`: GH_TOKEN, GITHUB_REPOSITORY, TRIGGER_SHA (the pushed commit), BEFORE_SHA
// (main before the push), GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { addEntry, entryBody, mergeNotes, parseNotes, renderEntry } from "./changelog.mjs";

const out = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const git = (...args) => out("git", args);
const die = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};
const notice = (message) => console.log(`::notice::${message}`);
const setOutput = (name, value) => {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
const TAG = /^(.+)-v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/;
const RELEASE_COMMIT = /^release: (.+-v\d+\.\d+\.\d+(?:-rc\.\d+)?)$/;
const WALK_CAP = 200;

function parseVersion(text) {
  const m = text.match(SEMVER);
  if (!m) throw new Error(`not a version: ${text}`);
  return { text, core: [+m[1], +m[2], +m[3]], rc: m[4] === undefined ? null : +m[4] };
}
const compareCore = (a, b) => a.core.reduce((d, n, i) => d || n - b.core[i], 0);
// A stable version sorts above its own release candidates.
const compareVersions = (a, b) => compareCore(a, b) || (a.rc ?? Infinity) - (b.rc ?? Infinity);
const maxOf = (versions) =>
  versions.reduce((m, v) => (!m || compareVersions(v, m) > 0 ? v : m), null);
const bump = ([major, minor, patch], kind) =>
  kind === "major"
    ? [major + 1, 0, 0]
    : kind === "minor"
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1];

// kind: patch | minor | major | rc. `versions` are every release the package has.
export function nextVersion(versions, kind) {
  const stable = maxOf(versions.filter((v) => v.rc === null));
  const last = maxOf(versions);
  const pending = last?.rc === null ? null : last; // a release candidate newer than the stable line
  const wanted = stable ? { core: bump(stable.core, kind === "rc" ? "patch" : kind) } : null;
  const core =
    kind === "rc"
      ? (pending ?? wanted).core
      : [pending, wanted].filter(Boolean).reduce((a, b) => (compareCore(a, b) >= 0 ? a : b)).core;
  if (kind !== "rc") return core.join(".");
  const rcs = versions
    .filter((v) => v.rc !== null && v.core.join() === core.join())
    .map((v) => v.rc);
  return `${core.join(".")}-rc.${Math.max(0, ...rcs) + 1}`;
}

// release:skip skips; patch/stable, minor, major and rc pick the bump; anything else, several kinds
// at once, or no label at all is an rc.
export function kindFromLabels(labels) {
  const release = labels
    .filter((l) => l.startsWith("release:"))
    .map((l) => l.slice("release:".length));
  if (release.includes("skip")) return "skip";
  const kinds = new Set(release.map((l) => (l === "stable" ? "patch" : l)));
  const [only] = kinds;
  return kinds.size === 1 && ["patch", "minor", "major", "rc"].includes(only) ? only : "rc";
}

const gh = (path) =>
  JSON.parse(out("gh", ["api", "-H", "Accept: application/vnd.github+json", path]));

// The merged PR targeting main that `sha` landed through, or null for a direct push.
function prFor(sha) {
  const merged = gh(`repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`).filter(
    (pr) => pr.merged_at && pr.base.ref === "main",
  );
  const exact = merged.filter((pr) => pr.merge_commit_sha === sha);
  const found = exact.length ? exact : merged;
  if (found.length > 1)
    die(
      `commit ${sha} resolves to several merged PRs (${found.map((p) => p.number)}); not guessing`,
    );
  return found[0] ?? null;
}

const packageDirs = () =>
  git("ls-files", "packages/*/package.json")
    .split("\n")
    .filter(Boolean)
    .map((path) => path.split("/")[1])
    .filter((dir) => !JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")).private);

function releaseOne(dir, kind, trigger) {
  const tags = git("tag", "--merged", "HEAD", "--list", `${dir}-v*`)
    .split("\n")
    .filter((t) => TAG.test(t) && TAG.exec(t)[1] === dir);
  const versions = tags.map((t) => parseVersion(TAG.exec(t)[2]));
  if (versions.length === 0) {
    die(
      `${dir} has no ${dir}-v<version> tag. Publish its first version by hand and tag it before merging changes to it (AGENTS.md, Releasing)`,
    );
  }

  // Rerun: the release commit for this trigger exists; make sure its tag does too.
  const done = git(
    "log",
    "--first-parent",
    "-F",
    `--grep=Release-Trigger: ${trigger}`,
    "--format=%H%x09%s",
  )
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, subject]) => RELEASE_COMMIT.exec(subject ?? "")?.[1].startsWith(`${dir}-v`));
  if (done) {
    const tag = RELEASE_COMMIT.exec(done[1])[1];
    if (!tags.includes(tag)) git("tag", tag, done[0]);
    notice(`${dir}: release for ${trigger} already committed as ${tag}`);
    return tag;
  }

  const lastTag = `${dir}-v${maxOf(versions).text}`;
  if (isAncestor(trigger, lastTag)) {
    notice(`${dir}: ${trigger} is already part of ${lastTag}; nothing to release`);
    return null;
  }

  const version = nextVersion(versions, kind);
  const tag = `${dir}-v${version}`;

  // The merged PRs that changed this package since its last release, oldest first. A stable
  // release covers everything since the last stable one, so it carries the notes of the release
  // candidates before it.
  const lastStable = maxOf(versions.filter((v) => v.rc === null));
  const since = version.includes("-") || !lastStable ? lastTag : `${dir}-v${lastStable.text}`;
  const commits = git(
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%s",
    `${since}..HEAD`,
    "--",
    `packages/${dir}`,
  )
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([sha, subject]) => sha && !subject.startsWith("release: "))
    .map(([sha]) => sha);
  if (commits.length > WALK_CAP)
    die(
      `${commits.length} commits touch ${dir} since ${since}; the walk costs one API call each and stops at ${WALK_CAP}`,
    );
  const prs = new Map();
  for (const sha of commits) {
    const pr = prFor(sha);
    if (pr) prs.set(pr.number, pr);
    else console.log(`skipped ${sha}: no merged PR (direct push)`);
  }
  const notes = [];
  for (const pr of prs.values()) {
    const { errors, notes: parsed } = parseNotes(pr.body ?? "");
    if (errors.length)
      console.log(
        `::warning::PR #${pr.number} has no usable '## Changelog' (${errors[0]}); left out of ${tag}`,
      );
    else notes.push(parsed);
  }

  const date = new Date().toISOString().slice(0, 10);
  const changelogPath = `packages/${dir}/CHANGELOG.md`;
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null;
  writeFileSync(changelogPath, addEntry(changelog, renderEntry(version, date, mergeNotes(notes))));
  const manifestPath = `packages/${dir}/package.json`;
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, "utf8").replace(/("version":\s*")[^"]+"/, `$1${version}"`),
  );

  git("add", changelogPath, manifestPath);
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    `release: ${tag}`,
    "-m",
    `Release-Trigger: ${trigger}`,
  );
  git("tag", tag);
  console.log(`released ${tag} from ${[...prs.keys()].map((n) => `#${n}`).join(", ") || "no PRs"}`);
  return tag;
}

function isAncestor(commit, of) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, of], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function release() {
  const trigger = process.env.TRIGGER_SHA;
  if (!isAncestor(trigger, "HEAD"))
    die(`${trigger} is not part of main's tip ${git("rev-parse", "HEAD")}`);
  const pr = prFor(trigger);
  if (!pr) {
    notice("no merged PR for this push (a direct push or a release commit); nothing to release");
    return setOutput("tags", "[]");
  }
  const kind = kindFromLabels(pr.labels.map((l) => l.name));
  console.log(`PR #${pr.number}: release kind ${kind}`);
  if (kind === "skip") return setOutput("tags", "[]");

  const before = /^0+$/.test(process.env.BEFORE_SHA ?? "0")
    ? `${trigger}^`
    : process.env.BEFORE_SHA;
  const changed = new Set(
    git("diff", "--name-only", before, trigger, "--", "packages")
      .split("\n")
      .map((p) => p.split("/")[1]),
  );
  const dirs = packageDirs().filter((dir) => changed.has(dir));
  if (dirs.length === 0) notice(`PR #${pr.number} changed no package; nothing to release`);

  const tags = dirs.map((dir) => releaseOne(dir, kind, trigger)).filter(Boolean);
  if (tags.length) git("push", "--atomic", "origin", "HEAD:main", ...tags);
  setOutput("tags", JSON.stringify(tags));
}

function onNpm(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch (error) {
    // E404 is a version (or package) that doesn't exist; a network or registry failure must not
    // read as "unpublished".
    if (!String(error.stderr).includes("E404")) throw error;
    return false;
  }
}

function resolve(arg) {
  const tags = arg.startsWith("[") ? JSON.parse(arg) : [arg];
  git("fetch", "--quiet", "origin", "main");
  const releases = tags.map((tag) => {
    const m = TAG.exec(tag);
    if (!m) die(`${tag} is not <package-dir>-v<version>`);
    const [, dir, version] = m;
    const manifest = JSON.parse(git("show", `${tag}:packages/${dir}/package.json`));
    if (manifest.private) die(`${dir} is private`);
    if (manifest.version !== version) die(`${tag}: package.json says ${manifest.version}`);
    if (!isAncestor(tag, "origin/main")) die(`${tag} is not reachable from main`);
    return {
      tag,
      dir,
      name: manifest.name,
      version,
      distTag: version.includes("-") ? "next" : "latest",
    };
  });
  setOutput("releases", JSON.stringify(releases));
  setOutput("unpublished", JSON.stringify(releases.filter((r) => !onNpm(r.name, r.version))));
}

function notes(tag) {
  const [, dir, version] = TAG.exec(tag);
  const path = `packages/${dir}/CHANGELOG.md`;
  process.stdout.write(entryBody(existsSync(path) ? readFileSync(path, "utf8") : null, version));
}

function validatePr(bodyFile, baseRef) {
  const { errors } = parseNotes(readFileSync(bodyFile, "utf8"));
  // Three dots: only what this PR changed, not what the base gained since (a release commit).
  const edited = git("diff", "--name-only", `origin/${baseRef}...HEAD`)
    .split("\n")
    .filter((p) => p.split("/").at(-1) === "CHANGELOG.md");
  for (const path of edited)
    errors.push(
      `${path} is edited; the release job owns it, and renders entries from '## Changelog'`,
    );
  for (const error of errors) console.log(`::error::${error}`);
  if (errors.length) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.filename === process.argv[1]) {
  const commands = {
    release,
    resolve: () => resolve(args[0]),
    notes: () => notes(args[0]),
    "validate-pr": () => validatePr(args[0], args[1]),
  };
  if (!commands[command]) die(`usage: release.mjs ${Object.keys(commands).join("|")}`);
  commands[command]();
}
