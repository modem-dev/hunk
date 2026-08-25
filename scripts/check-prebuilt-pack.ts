#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** Read one package manifest from disk. */
function readPackageManifest(directory: string) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as PackageManifest;
}

/** Verify CLI installs can omit Pierre while OpenTUI consumers can provide it. */
function assertPierreDependencyContract(root: PackageManifest, staged: PackageManifest) {
  const packageName = "@pierre/diffs";
  const expectedVersion = root.devDependencies?.[packageName];

  if (!expectedVersion) {
    throw new Error(`Expected ${packageName} to remain a development dependency.`);
  }
  if (root.dependencies?.[packageName] !== undefined) {
    throw new Error(`Expected ${packageName} to stay out of runtime dependencies.`);
  }
  if (
    root.peerDependencies?.[packageName] !== expectedVersion ||
    root.peerDependenciesMeta?.[packageName]?.optional !== true
  ) {
    throw new Error(
      `Expected ${packageName}@${expectedVersion} to be an optional peer dependency.`,
    );
  }
  if (staged.dependencies?.[packageName] !== undefined) {
    throw new Error(`Expected staged ${packageName} to stay out of runtime dependencies.`);
  }
  if (
    staged.peerDependencies?.[packageName] !== expectedVersion ||
    staged.peerDependenciesMeta?.[packageName]?.optional !== true
  ) {
    throw new Error(`Expected the staged package to preserve the optional ${packageName} peer.`);
  }
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

assertPierreDependencyContract(readPackageManifest(repoRoot), readPackageManifest(metaDir));

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
  "README.md",
  "LICENSE",
  "package.json",
]);

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
