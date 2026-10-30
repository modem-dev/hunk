#!/usr/bin/env bun

/**
 * Versions workspace packages while keeping the repository changelog canonical.
 *
 * Changesets writes a changelog beside each publishable manifest. Hunk intentionally keeps its
 * release history at the repository root, so the root file is staged beside `packages/hunk` only
 * for the duration of the Changesets command and copied back after a successful version update.
 *
 * Bun records each non-root workspace version in `bun.lock`, and Changesets only rewrites
 * manifests, so a successful version update also refreshes the lockfile. Otherwise the release
 * commit leaves the old `hunkdiff` version behind and the next `bun install` rewrites it.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { HUNK_PACKAGE_ROOT, REPO_ROOT } from "../build/package-paths";

export interface ChangesetVersionPaths {
  repoRoot: string;
  packageRoot: string;
}

/** External commands the version operation runs from the repository root; each returns an exit code. */
export interface ChangesetVersionCommands {
  runChangesets: (repoRoot: string) => number;
  refreshLockfile: (repoRoot: string) => number;
}

/** Run one command from the repository root with the caller's terminal attached. */
function runInRepo(command: string[], repoRoot: string) {
  return Bun.spawnSync(command, {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }).exitCode;
}

const RELEASE_COMMANDS: ChangesetVersionCommands = {
  runChangesets: (repoRoot) =>
    runInRepo([process.execPath, "x", "@changesets/cli@2.31.0", "version"], repoRoot),
  refreshLockfile: (repoRoot) =>
    runInRepo([process.execPath, "install", "--lockfile-only"], repoRoot),
};

/** Run one Changesets version operation against an explicitly staged canonical changelog. */
export function versionPackages(
  paths: ChangesetVersionPaths,
  commands: ChangesetVersionCommands = RELEASE_COMMANDS,
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
    const exitCode = commands.runChangesets(paths.repoRoot);
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

  // Manifests and the changelog are already versioned here, so a failure only needs a re-run of
  // the refresh, not of Changesets.
  const lockfileExitCode = commands.refreshLockfile(paths.repoRoot);
  if (lockfileExitCode !== 0) {
    throw new Error(
      `bun.lock refresh failed with exit ${lockfileExitCode}; run \`bun install --lockfile-only\`.`,
    );
  }
}

if (import.meta.main) {
  versionPackages({ repoRoot: REPO_ROOT, packageRoot: HUNK_PACKAGE_ROOT });
}
