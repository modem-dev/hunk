#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { BUNDLED_SKILL_NAMES } from "../src/core/run/paths";
import { releaseNpmDir } from "./prebuilt-package-helpers";
import { npmCommand } from "./script-helpers";

interface PackedFile {
  path: string;
}

interface PackResult {
  name: string;
  version: string;
  files: PackedFile[];
}

function runPackDryRun(cwd: string) {
  const proc = Bun.spawnSync([npmCommand, "pack", "--dry-run", "--json"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
  const stderr = Buffer.from(proc.stderr).toString("utf8").trim();

  if (proc.exitCode !== 0) {
    throw new Error(stderr || stdout || `npm pack --dry-run failed in ${cwd}`);
  }

  const jsonMatch = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  const jsonText = jsonMatch?.[1];
  if (!jsonText) {
    throw new Error(`Could not find npm pack JSON output for ${cwd}. Full stdout:\n${stdout}`);
  }

  const [pack] = JSON.parse(jsonText) as PackResult[];
  if (!pack) {
    throw new Error(`npm pack --dry-run returned no result for ${cwd}`);
  }

  return pack;
}

function assertPaths(pack: PackResult, requiredPaths: string[]) {
  const publishedPaths = new Set(pack.files.map((file) => file.path));

  for (const requiredPath of requiredPaths) {
    if (!publishedPaths.has(requiredPath)) {
      throw new Error(`Expected ${pack.name} to include ${requiredPath}.`);
    }
  }
}

const repoRoot = path.resolve(import.meta.dir, "..");
const releaseRoot = releaseNpmDir(repoRoot);
const metaDir = path.join(releaseRoot, "hunkdiff");

if (!existsSync(metaDir)) {
  throw new Error(`Missing staged top-level package at ${metaDir}`);
}

const metaPack = runPackDryRun(metaDir);
assertPaths(metaPack, [
  "bin/hunk.cjs",
  "dist/npm/main.js",
  "dist/npm/extension/index.d.ts",
  "dist/npm/extension/index.js",
  "dist/npm/opentui/index.d.ts",
  "dist/npm/opentui/index.js",
  "skills/hunk-review/SKILL.md",
  "skills/hunk-extensions/SKILL.md",
  "skills/opentui-performance/SKILL.md",
  "skills/opentui-performance/references/rendering-and-geometry.md",
  "skills/opentui-performance/references/async-and-memory.md",
  "skills/opentui-performance/references/benchmarking-and-validation.md",
  "skills/opentui-performance/references/hunk-case-study.md",
  "README.md",
  "LICENSE",
  "package.json",
]);

const bundledSkillPrefixes = BUNDLED_SKILL_NAMES.map((name) => `skills/${name}/`);
for (const file of metaPack.files) {
  if (
    file.path.startsWith("skills/") &&
    !bundledSkillPrefixes.some((prefix) => file.path.startsWith(prefix))
  ) {
    throw new Error(`Unexpected maintainer-only skill in prebuilt package: ${file.path}`);
  }
}

const packageDirectories = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "hunkdiff")
  .map((entry) => path.join(releaseRoot, entry.name))
  .sort();

if (packageDirectories.length === 0) {
  throw new Error(`No staged platform packages found in ${releaseRoot}`);
}

const verifiedNames = [metaPack.name];
for (const packageDirectory of packageDirectories) {
  const pack = runPackDryRun(packageDirectory);
  assertPaths(pack, ["LICENSE", "package.json"]);
  const binaryPath = pack.files.find((file) => file.path.startsWith("bin/"))?.path;
  if (!binaryPath) {
    throw new Error(`Expected ${pack.name} to publish one binary under bin/.`);
  }
  verifiedNames.push(pack.name);
}

console.log(`Verified prebuilt npm packages for ${metaPack.version}: ${verifiedNames.join(", ")}`);
