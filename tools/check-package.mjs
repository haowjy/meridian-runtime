#!/usr/bin/env node
// Proves the published tarball works for a consumer outside this repo: packs it (as `npm publish`
// would ship it), installs it with plain npm into an empty project, imports every entry under
// Node, and typechecks the .d.ts files strictly, once with @types/node and once without it for the
// entries listed in `meridianRuntime.nodeFreeEntries`. An import that only resolves inside the
// repo, or a Node type leaking into a browser entry, fails here.
//
// It runs for two consumers, the repo's toolchain and the floor (TypeScript 6, @types/node 22).
//
// The README's first `ts` block is typechecked there too, so the npm page's example compiles.
//
// Usage: node tools/check-package.mjs [--keep <dir>]
//   --keep leaves the tarball in <dir> (the publish workflow uploads it).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keepDir = keepAt >= 0 ? resolve(args[keepAt + 1]) : undefined;

const pkg = readJson(join(repo, "package.json"));
// Two consumers, each with its own install: the repo's toolchain, and the oldest one the package
// supports (TypeScript 6 reads declarations emitted by 7; `engines.node` allows Node 22).
const consumers = [
  {
    name: "current",
    typescript: pkg.devDependencies.typescript,
    typesNode: pkg.devDependencies["@types/node"],
  },
  { name: "floor", typescript: "6", typesNode: "22" },
];

function check() {
  const work = mkdtempSync(join(tmpdir(), "package-consumer-"));
  try {
    const packDir = keepDir ?? join(work, "pack");
    mkdirSync(packDir, { recursive: true });

    // pnpm pack runs prepack (build).
    run("pnpm", ["pack", "--pack-destination", packDir], repo);
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

    for (const consumer of consumers) {
      const project = join(work, `consumer-${consumer.name}`);
      mkdirSync(project);
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
          `@types/node@${consumer.typesNode}`,
          `typescript@${consumer.typescript}`,
          // An optional peer (vitest, for ./script/testing) is not installed unless named.
          ...Object.entries(packed.peerDependencies ?? {}).map(([dep, range]) => `${dep}@${range}`),
        ],
        project,
      );

      const typecheck = (name, source, types) => {
        writeFileSync(join(project, `${name}.ts`), source);
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
        run(
          process.execPath,
          ["node_modules/typescript/bin/tsc", "-p", `tsconfig.${name}.json`],
          project,
        );
      };
      const importAll = (specifiers) =>
        `${specifiers.map((s, i) => `import * as m${i} from "${s}";`).join("\n")}\nexport const entries = [${specifiers.map((_, i) => `m${i}`).join(", ")}];\n`;
      typecheck("all", importAll(entries), ["node"]);
      if (nodeFree.length > 0) typecheck("node-free", importAll(nodeFree), []);
      const example = readFileSync(join(repo, "README.md"), "utf8").match(
        /```ts\n([\s\S]*?)```/,
      )?.[1];
      if (!example) throw new Error("README.md has no ts example");
      typecheck("readme-example", example, ["node"]);

      for (const entry of entries) {
        run(
          process.execPath,
          ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`],
          project,
        );
      }
      console.log(
        `  ${consumer.name} consumer (TypeScript ${consumer.typescript}, @types/node ${consumer.typesNode}): ok`,
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
  check();
} catch (error) {
  console.error(`package check failed: ${error.message}`);
  process.exitCode = 1;
}
