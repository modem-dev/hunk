#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(repoRoot, "dist");
const binaryName = process.platform === "win32" ? "hunk.exe" : "hunk";
const outfile = path.join(distDir, binaryName);
const legacyOutfile = path.join(distDir, process.platform === "win32" ? "otdiff.exe" : "otdiff");

mkdirSync(distDir, { recursive: true });
rmSync(legacyOutfile, { force: true });

const buildArgs = ["bun", "build", "--compile", "--no-compile-autoload-bunfig"];
const targetTriple = process.env.HUNK_TARGET_TRIPLE;
if (targetTriple) {
  buildArgs.push("--target", targetTriple);
}
buildArgs.push(path.join(repoRoot, "src", "main.tsx"), "--outfile", outfile);

const proc = Bun.spawnSync(buildArgs, {
  cwd: repoRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    BUN_TMPDIR: path.join(repoRoot, ".bun-tmp"),
    BUN_INSTALL: path.join(repoRoot, ".bun-install"),
  },
});

if (proc.exitCode !== 0) {
  throw new Error(`bun build --compile failed with exit ${proc.exitCode}`);
}

console.log(`Built ${outfile}`);
