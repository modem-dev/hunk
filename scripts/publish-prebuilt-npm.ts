#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { releaseNpmDir } from "./prebuilt-package-helpers";

type PackageJson = {
  name: string;
  version: string;
};

function parseArgs(argv: string[]) {
  let dryRun = false;
  let npmTag = "latest";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argument === "--tag") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --tag");
      }
      npmTag = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    dryRun,
    npmTag,
  };
}

function npmViewExists(name: string, version: string) {
  const proc = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });

  return proc.exitCode === 0;
}

function publishDirectory(directory: string, dryRun: boolean, npmTag: string) {
  const packageJson = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  ) as PackageJson;

  if (npmViewExists(packageJson.name, packageJson.version)) {
    console.log(
      dryRun
        ? `Skipping npm publish dry-run for ${packageJson.name}@${packageJson.version}; that version already exists on npm.`
        : `Skipping ${packageJson.name}@${packageJson.version}; already published.`,
    );
    return;
  }

  const args = ["publish", "--access", "public", "--tag", npmTag];
  if (dryRun) {
    args.push("--dry-run");
  }

  const proc = Bun.spawnSync(["npm", ...args], {
    cwd: directory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  if (proc.exitCode !== 0) {
    throw new Error(`npm publish failed for ${packageJson.name}@${packageJson.version}`);
  }
}

const repoRoot = path.resolve(import.meta.dir, "..");
const releaseRoot = releaseNpmDir(repoRoot);
const options = parseArgs(process.argv.slice(2));

if (!existsSync(releaseRoot)) {
  throw new Error(`Missing staged npm release directory at ${releaseRoot}`);
}

const directories = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => {
    if (left === "hunkdiff") return 1;
    if (right === "hunkdiff") return -1;
    return left.localeCompare(right);
  })
  .map((entry) => path.join(releaseRoot, entry));

if (directories.length === 0) {
  throw new Error(`No staged packages found in ${releaseRoot}`);
}

for (const directory of directories) {
  publishDirectory(directory, options.dryRun, options.npmTag);
}

console.log(
  options.dryRun
    ? `Completed npm publish dry-run for staged prebuilt packages with dist-tag \"${options.npmTag}\".`
    : `Published staged prebuilt packages to npm with dist-tag \"${options.npmTag}\".`,
);
