#!/usr/bin/env node
// Prints, one JSON object per line, each public package under packages/ whose version is not on
// npm yet: {"dir":"packages/gateway","name":"@meridian-flow/gateway","version":"0.1.0",
// "distTag":"latest"}. A pre-release version goes to the `next` dist-tag.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
for (const dir of readdirSync(join(repo, "packages"))) {
  const manifest = join(repo, "packages", dir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private) continue;
  let published = false;
  try {
    execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], { stdio: "pipe" });
    published = true;
  } catch (error) {
    // npm exits non-zero with E404 for a version (or package) that doesn't exist; anything else
    // (network, registry outage) must not be read as "unpublished".
    if (!String(error.stderr).includes("E404")) throw error;
  }
  if (published) continue;
  console.log(
    JSON.stringify({
      dir: `packages/${dir}`,
      name: pkg.name,
      version: pkg.version,
      distTag: pkg.version.includes("-") ? "next" : "latest",
    }),
  );
}
