#!/usr/bin/env bun

/**
 * Versions workspace packages while keeping the repository changelog canonical.
 *
 * Changesets writes a changelog beside each publishable manifest. Hunk intentionally keeps its
 * release history at the repository root, so the root file is staged beside `packages/hunk` only
 * for the duration of the Changesets command and copied back after a successful version update.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { HUNK_PACKAGE_ROOT, REPO_ROOT } from "./package-paths";

export interface ChangesetVersionPaths {
  repoRoot: string;
  packageRoot: string;
}

/** Run one Changesets version operation against an explicitly staged canonical changelog. */
export function versionPackages(
  paths: ChangesetVersionPaths,
  runChangesets: (repoRoot: string) => number = (repoRoot) =>
    Bun.spawnSync(["bun", "x", "@changesets/cli@2.31.0", "version"], {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    }).exitCode,
) {
  const canonicalChangelog = path.join(paths.repoRoot, "CHANGELOG.md");
  const packageChangelog = path.join(paths.packageRoot, "CHANGELOG.md");

  if (!existsSync(canonicalChangelog)) {
    throw new Error(`Missing canonical changelog at ${canonicalChangelog}.`);
  }
  if (existsSync(packageChangelog)) {
    throw new Error(
      `Unexpected ${packageChangelog}; CHANGELOG.md is owned at the repository root.`,
    );
  }

  copyFileSync(canonicalChangelog, packageChangelog);
  try {
    const exitCode = runChangesets(paths.repoRoot);
    if (exitCode !== 0) {
      throw new Error(`Changesets version failed with exit ${exitCode}.`);
    }
    if (!existsSync(packageChangelog)) {
      throw new Error("Changesets did not produce the hunkdiff package changelog.");
    }
    copyFileSync(packageChangelog, canonicalChangelog);
  } finally {
    rmSync(packageChangelog, { force: true });
  }
}

if (import.meta.main) {
  versionPackages({ repoRoot: REPO_ROOT, packageRoot: HUNK_PACKAGE_ROOT });
}
