#!/usr/bin/env node
// The release process's steps, run by .github/workflows/release.yml and pr-body.yml.
//
//   release              release each package touched since its last tag: bump its version,
//                        render its CHANGELOG.md, commit `release: <dir>-v<version>`, tag
//                        `<dir>-v<version>`, push to main. Writes `tags=[...]` (the new tags and any
//                        latest tag not on npm yet) to $GITHUB_OUTPUT.
//   resolve <tags>       check each tag (a JSON array or one tag) and write `unpublished` (the ones
//                        not on npm yet) to $GITHUB_OUTPUT as JSON.
//   github-releases      create a GitHub Release for every `<dir>-v*` tag whose version is on npm
//                        and has none yet.
//   validate-pr <body-file> <base-ref>
//                        the PR body has a valid `## Changelog` and no CHANGELOG.md is edited.
//
// Env for `release` and `github-releases`: GH_TOKEN, GITHUB_REPOSITORY (and GITHUB_OUTPUT).
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
const WALK_CAP = 200;
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
// What `releaseOne` commits. A PR squash-merged under a title like `release: ...` is not one.
const RELEASE_SUBJECT = /^release: .+-v\d+\.\d+\.\d+(-rc\.\d+)?$/;

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

const RANK = ["rc", "patch", "minor", "major"];

// release:skip skips; patch/stable, minor, major and rc pick the bump; anything else, several kinds
// at once, or no label at all is an rc.
export function kindFromLabels(labels) {
  const release = labels
    .filter((l) => l.startsWith("release:"))
    .map((l) => l.slice("release:".length));
  if (release.includes("skip")) return "skip";
  const kinds = new Set(release.map((l) => (l === "stable" ? "patch" : l)));
  const [only] = kinds;
  return kinds.size === 1 && RANK.includes(only) ? only : "rc";
}

// The release a set of PR kinds adds up to: the strongest (rc < patch < minor < major), or null
// when every one is `skip`.
export const strongestKind = (kinds) => RANK.findLast((kind) => kinds.includes(kind)) ?? null;

const gh = (path) =>
  JSON.parse(out("gh", ["api", "-H", "Accept: application/vnd.github+json", path]));

// The merged PR targeting main that `sha` landed through, or null for a direct push.
const prCache = new Map();
function prFor(sha) {
  if (!prCache.has(sha)) {
    const merged = gh(`repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`).filter(
      (pr) => pr.merged_at && pr.base.ref === "main",
    );
    const exact = merged.filter((pr) => pr.merge_commit_sha === sha);
    const found = exact.length ? exact : merged;
    if (found.length > 1)
      throw new Error(
        `commit ${sha} resolves to several merged PRs (${found.map((p) => p.number)}); not guessing`,
      );
    prCache.set(sha, found[0] ?? null);
  }
  return prCache.get(sha);
}

const packageDirs = () =>
  git("ls-files", "packages/*/package.json")
    .split("\n")
    .filter(Boolean)
    .map((path) => path.split("/")[1])
    .filter((dir) => !JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")).private);

const versionsOf = (dir) =>
  git("tag", "--merged", "HEAD", "--list", `${dir}-v*`)
    .split("\n")
    .filter((t) => TAG.test(t) && TAG.exec(t)[1] === dir)
    .map((t) => parseVersion(TAG.exec(t)[2]));

// The commits that touched the package since `ref`, oldest first, release commits left out.
function touchedSince(dir, ref) {
  const commits = git(
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%s%x09%ae",
    `${ref}..HEAD`,
    "--",
    `packages/${dir}`,
  )
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([sha, subject, email]) => sha && !(RELEASE_SUBJECT.test(subject) && email === BOT_EMAIL),
    )
    .map(([sha]) => sha);
  if (commits.length > WALK_CAP)
    throw new Error(
      `${commits.length} commits touch ${dir} since ${ref}; the walk costs one API call each and stops at ${WALK_CAP}. Tag the package by hand at a release commit to reset the walk`,
    );
  return commits;
}

// Release the package if anything touched it since its last tag, on the strongest label among the
// PRs that did. Decided from what main holds, never from the push that started the run.
function releaseOne(dir) {
  const versions = versionsOf(dir);
  if (versions.length === 0) {
    console.log(
      `::warning::${dir} has no ${dir}-v<version> tag, so it is not released. Publish its first version by hand and tag it (AGENTS.md, Releasing)`,
    );
    return null;
  }
  const lastTag = `${dir}-v${maxOf(versions).text}`;
  const fresh = touchedSince(dir, lastTag);
  if (fresh.length === 0) return null;

  const kinds = fresh.map((sha) => {
    const pr = prFor(sha);
    if (!pr) console.log(`${sha}: no merged PR (direct push), counted as an rc`);
    return pr ? kindFromLabels(pr.labels.map((l) => l.name)) : "rc";
  });
  const kind = strongestKind(kinds);
  if (!kind) {
    notice(`${dir}: every change since ${lastTag} is release:skip; nothing to release`);
    return null;
  }

  const version = nextVersion(versions, kind);
  const tag = `${dir}-v${version}`;

  // A stable release covers everything since the last stable one, so it carries the notes of the
  // release candidates before it.
  const lastStable = maxOf(versions.filter((v) => v.rc === null));
  const since = version.includes("-") || !lastStable ? lastTag : `${dir}-v${lastStable.text}`;
  const prs = new Map();
  for (const sha of touchedSince(dir, since)) {
    const pr = prFor(sha);
    if (pr) prs.set(pr.number, pr);
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
    `user.email=${BOT_EMAIL}`,
    "commit",
    "-m",
    `release: ${tag}`,
  );
  git("tag", tag);
  console.log(`${tag}: ${kind} release from ${[...prs.keys()].map((n) => `#${n}`).join(", ")}`);
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

// Mars's loop, in state form: a rejected push means main moved, so start over from the new main
// instead of replaying our commit, and the release covers whatever landed meanwhile.
function release() {
  let released = [];
  const failures = [];
  for (let attempt = 1; ; attempt++) {
    git("fetch", "--quiet", "--force", "--tags", "origin", "main");
    git("reset", "--hard", "origin/main");
    failures.length = 0;
    // One package failing leaves the others to release.
    released = packageDirs().flatMap((dir) => {
      try {
        return releaseOne(dir) ?? [];
      } catch (error) {
        failures.push(`${dir}: ${error.message}`);
        return [];
      }
    });
    if (released.length === 0) break;
    try {
      git("push", "--atomic", "origin", "HEAD:main", ...released);
      break;
    } catch {
      if (attempt === 3) die("could not push the release commit to main after 3 attempts");
      console.log(
        `::warning::push to main rejected on attempt ${attempt}; starting over from main`,
      );
      for (const tag of released) git("tag", "-d", tag);
    }
  }

  // A package's latest tag that never reached npm (a failed or cancelled run) is published now.
  const pending = packageDirs().flatMap((dir) => {
    const latest = maxOf(versionsOf(dir));
    if (!latest) return [];
    const tag = `${dir}-v${latest.text}`;
    return onNpm(manifestName(dir), latest.text) ? [] : [tag];
  });
  setOutput("tags", JSON.stringify([...new Set([...released, ...pending])]));
  if (failures.length) die(`not released: ${failures.join("; ")}`);
}

const manifestName = (dir) => JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")).name;

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
  setOutput("unpublished", JSON.stringify(releases.filter((r) => !onNpm(r.name, r.version))));
}

// The CHANGELOG.md entry as the tag holds it.
function notes(tag) {
  const [, dir, version] = TAG.exec(tag);
  let changelog = null;
  try {
    changelog = execFileSync("git", ["show", `${tag}:packages/${dir}/CHANGELOG.md`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {} // a package's first versions have no CHANGELOG.md
  return entryBody(changelog, version);
}

// Every step is decided from state: a tag on npm with no GitHub Release gets one, whichever run
// published it, and a tag not on npm never does.
function githubReleases() {
  const existing = new Set(
    JSON.parse(out("gh", ["release", "list", "--limit", "1000", "--json", "tagName"])).map(
      (r) => r.tagName,
    ),
  );
  const tags = git("tag", "--list", "*-v*").split("\n").filter(Boolean);
  for (const dir of packageDirs()) {
    const name = manifestName(dir);
    for (const tag of tags) {
      const m = TAG.exec(tag);
      if (m?.[1] !== dir || existing.has(tag) || !onNpm(name, m[2])) continue;
      const version = m[2];
      const body = notes(tag);
      const args = [
        "--title",
        `${name}@${version}`,
        `--prerelease=${version.includes("-")}`,
        ...(body ? ["--notes", body] : ["--generate-notes"]),
      ];
      try {
        out("gh", ["release", "create", tag, ...args, "--verify-tag"]);
      } catch (error) {
        // A run that overlapped this one made it first.
        try {
          out("gh", ["release", "view", tag]);
        } catch {
          throw error;
        }
      }
      console.log(`${tag}: GitHub Release created`);
    }
  }
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
    "github-releases": githubReleases,
    "validate-pr": () => validatePr(args[0], args[1]),
  };
  if (!commands[command]) die(`usage: release.mjs ${Object.keys(commands).join("|")}`);
  commands[command]();
}
