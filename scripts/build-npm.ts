#!/usr/bin/env bun

import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const outdir = path.join(repoRoot, "dist", "npm");
const typesOutdir = path.join(repoRoot, "dist", "npm-types");
const opentuiOutdir = path.join(outdir, "opentui");
const opentuiTypesDir = path.join(typesOutdir, "opentui");
const embeddedOutdir = path.join(outdir, "embedded");

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

runBun([
  "build",
  path.join(repoRoot, "src", "opentui", "index.ts"),
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "react",
  "--external",
  "react/jsx-runtime",
  "--external",
  "react/jsx-dev-runtime",
  "--external",
  "@opentui/core",
  "--external",
  "@opentui/react",
  "--external",
  "@opentui/react/jsx-runtime",
  "--external",
  "@opentui/react/jsx-dev-runtime",
  "--external",
  "@pierre/diffs",
  "--outdir",
  opentuiOutdir,
  "--entry-naming",
  "index.js",
]);

const embeddedBuild = await Bun.build({
  entrypoints: [path.join(repoRoot, "src", "embedded", "index.tsx")],
  target: "node",
  format: "esm",
  outdir: embeddedOutdir,
  naming: { entry: "index.js" },
  external: ["@opentui/core", "@opentui/react", "@pierre/diffs", "react", "react/jsx-runtime"],
});

if (!embeddedBuild.success) {
  for (const log of embeddedBuild.logs) {
    console.error(log.message);
  }
  throw new Error("Failed to build embedded Hunk export.");
}

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
