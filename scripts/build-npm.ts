#!/usr/bin/env bun

import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const outdir = path.join(repoRoot, "dist", "npm");
const typesOutdir = path.join(repoRoot, "dist", "npm-types");
const opentuiOutdir = path.join(outdir, "opentui");
const opentuiTypesDir = path.join(typesOutdir, "opentui");
const embeddedOutdir = path.join(outdir, "embedded");
const libraryExternals = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@opentui/core",
  "@opentui/react",
  "@opentui/react/jsx-runtime",
  "@opentui/react/jsx-dev-runtime",
  "@pierre/diffs",
];

const bunEnv = {
  ...process.env,
  BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
  BUN_INSTALL: path.join(repoRoot, ".bun-install"),
};

function runBun(args: string[]) {
  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: bunEnv,
  });

  if (proc.exitCode !== 0) {
    throw new Error(`bun ${args.join(" ")} failed with exit ${proc.exitCode}`);
  }
}

async function buildLibraryExport(name: string, entrypoint: string, outputDirectory: string) {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "node",
    format: "esm",
    outdir: outputDirectory,
    naming: { entry: "index.js" },
    external: libraryExternals,
  });

  if (!build.success) {
    for (const log of build.logs) {
      console.error(log.message);
    }
    throw new Error(`Failed to build ${name} export.`);
  }
}

rmSync(outdir, { recursive: true, force: true });
rmSync(typesOutdir, { recursive: true, force: true });
mkdirSync(opentuiOutdir, { recursive: true });
mkdirSync(embeddedOutdir, { recursive: true });

runBun([
  "build",
  path.join(repoRoot, "src", "main.tsx"),
  "--target",
  "bun",
  "--format",
  "esm",
  "--outdir",
  outdir,
  "--entry-naming",
  "main.js",
]);

const mainJs = path.join(outdir, "main.js");
// chmod is a no-op on Windows; preserve exec bits on Unix so the bin runs in npm-installed packages.
if (process.platform !== "win32") {
  chmodSync(mainJs, 0o755);
}

await buildLibraryExport(
  "OpenTUI",
  path.join(repoRoot, "src", "opentui", "index.ts"),
  opentuiOutdir,
);
await buildLibraryExport(
  "embedded Hunk",
  path.join(repoRoot, "src", "embedded", "index.tsx"),
  embeddedOutdir,
);

runBun(["x", "tsc", "-p", path.join(repoRoot, "tsconfig.opentui.json")]);

for (const entry of readdirSync(opentuiTypesDir)) {
  if (entry.endsWith(".d.ts")) {
    copyFileSync(path.join(opentuiTypesDir, entry), path.join(opentuiOutdir, entry));
  }
}

copyFileSync(
  path.join(repoRoot, "src", "embedded", "index.d.ts"),
  path.join(embeddedOutdir, "index.d.ts"),
);

rmSync(typesOutdir, { recursive: true, force: true });

console.log(`Built ${mainJs}`);
console.log(`Built ${path.join(opentuiOutdir, "index.js")}`);
console.log(`Built ${path.join(embeddedOutdir, "index.js")}`);
