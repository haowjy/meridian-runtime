#!/usr/bin/env node
// Proves each published package's tarball works for a consumer outside this workspace: packs it
// (as `npm publish` would ship it), installs it with plain npm into an empty project, imports
// every entry under Node, and typechecks the .d.ts files strictly, once with @types/node and once
// without it for the entries listed in `meridianRuntime.nodeFreeEntries`. An import that only
// resolves inside the workspace, or a Node type leaking into a browser entry, fails here.
//
// Usage: node tools/check-package.mjs [package-dir ...] [--keep <dir>]
//   With no package dir, checks every non-private package under packages/.
//   --keep leaves the tarballs in <dir> (the publish workflow uploads them).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const tsc = join(repo, "node_modules/typescript/bin/tsc");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keepDir = keepAt >= 0 ? resolve(args[keepAt + 1]) : undefined;
const named = args.filter((_, i) => keepAt < 0 || (i !== keepAt && i !== keepAt + 1));
const packageDirs = (
  named.length > 0
    ? named.map((dir) => resolve(dir))
    : readdirSync(join(repo, "packages")).map((dir) => join(repo, "packages", dir))
).filter(
  (dir) => existsSync(join(dir, "package.json")) && !readJson(join(dir, "package.json")).private,
);

const catalog = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
const typesNode = catalog.match(/^\s*["']?@types\/node["']?:\s*(\S+)/m)?.[1];
if (!typesNode) throw new Error("@types/node not found in the pnpm-workspace.yaml catalog");

function check(pkgDir) {
  const pkg = readJson(join(pkgDir, "package.json"));
  const work = mkdtempSync(join(tmpdir(), "package-consumer-"));
  try {
    const packDir = keepDir ?? join(work, "pack");
    const project = join(work, "consumer");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(project);

    // pnpm pack runs prepack (build) and writes concrete ranges for catalog: and workspace:.
    run("pnpm", ["pack", "--pack-destination", packDir], pkgDir);
    const prefix = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
    const tarball = join(packDir, prefix);
    const packed = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    for (const [field, deps] of Object.entries(packed)) {
      if (!field.endsWith("ependencies")) continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (/^(catalog|workspace|link|file):/.test(range))
          throw new Error(`${field}.${dep} is "${range}" in the tarball`);
      }
    }

    const entries = Object.keys(packed.exports).map((key) => packed.name + key.slice(1));
    const nodeFree = (pkg.meridianRuntime?.nodeFreeEntries ?? []).map(
      (key) => packed.name + key.slice(1),
    );

    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "package-consumer", private: true, type: "module" }),
    );
    // --ignore-scripts: nothing from the registry runs during the install.
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
        `@types/node@${typesNode}`,
      ],
      project,
    );

    const typecheck = (name, specifiers, types) => {
      if (specifiers.length === 0) return;
      const imports = specifiers.map((s, i) => `import * as m${i} from "${s}";`);
      writeFileSync(
        join(project, `${name}.ts`),
        `${imports.join("\n")}\nexport const entries = [${specifiers.map((_, i) => `m${i}`).join(", ")}];\n`,
      );
      writeFileSync(
        join(project, `tsconfig.${name}.json`),
        JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "ES2022",
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            types,
          },
          files: [`${name}.ts`],
        }),
      );
      run(process.execPath, [tsc, "-p", `tsconfig.${name}.json`], project);
    };
    typecheck("all", entries, ["node"]);
    typecheck("node-free", nodeFree, []);

    for (const entry of entries) {
      run(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`],
        project,
      );
    }
    console.log(
      `${pkg.name}@${pkg.version}: ${entries.length} entries import and typecheck for a consumer`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  for (const dir of packageDirs) check(dir);
} catch (error) {
  console.error(`package check failed: ${error.message}`);
  process.exitCode = 1;
}
