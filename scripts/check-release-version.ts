#!/usr/bin/env bun

import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageJson = JSON.parse(await Bun.file(path.join(repoRoot, "package.json")).text()) as {
  version: string;
};
const refName = process.argv[2];

if (!refName) {
  throw new Error("Usage: bun run ./scripts/check-release-version.ts <tag>");
}

const expectedTag = `v${packageJson.version}`;
if (refName !== expectedTag) {
  throw new Error(
    `Tag ${refName} does not match package.json version ${packageJson.version} (${expectedTag}).`,
  );
}

console.log(`Verified release tag ${refName} matches package.json version ${packageJson.version}.`);
