#!/usr/bin/env bun

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUNK_PACKAGE_ROOT, REPO_ROOT } from "./package-paths";

export const SOURCE_NPM_STAGE = path.join(REPO_ROOT, "dist", "source-npm", "hunkdiff");

/** Stage the publishable source npm package without private workspace build dependencies. */
export function stageSourceNpmPackage(
  destination = SOURCE_NPM_STAGE,
  packageRoot = HUNK_PACKAGE_ROOT,
) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  for (const entry of ["bin", "dist/npm", "skills", "README.md", "LICENSE"] as const) {
    cpSync(path.join(packageRoot, entry), path.join(destination, entry), { recursive: true });
  }

  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const devDependencies = { ...(manifest.devDependencies as Record<string, string>) };
  for (const packageName of Object.keys(devDependencies)) {
    if (packageName.startsWith("@hunk/")) delete devDependencies[packageName];
  }
  manifest.devDependencies = devDependencies;
  delete manifest.scripts;
  writeFileSync(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

if (import.meta.main) {
  console.log(`Staged ${stageSourceNpmPackage()}`);
}
