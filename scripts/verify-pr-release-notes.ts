#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

interface PackageManifest {
  name: string;
  version: string;
}

interface PrereleaseState {
  mode: string;
  tag: unknown;
  initialVersions: unknown;
  changesets: unknown;
}

interface GeneratedPrereleaseInput {
  packageJson: PackageManifest;
  pre: PrereleaseState;
  changelog: string;
  changesetIdsOnDisk: ReadonlySet<string>;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const RELEASE_BENCHMARK_PATTERN = /^benchmarks\/release\/bench-[^/]+\.json$/;
const CHANGESET_PATTERN = /^\.changeset\/[^/]+\.md$/;

/** Return whether a path is release metadata permitted in a generated prerelease PR. */
export function isGeneratedReleasePath(filePath: string) {
  return (
    filePath === ".changeset/pre.json" ||
    filePath === "CHANGELOG.md" ||
    filePath === "packages/hunk/package.json" ||
    CHANGESET_PATTERN.test(filePath) ||
    RELEASE_BENCHMARK_PATTERN.test(filePath)
  );
}

/** Select generated-prerelease validation only for metadata-only release preparation diffs. */
export function isGeneratedPrereleasePreparation(changedPaths: readonly string[]) {
  return (
    changedPaths.includes(".changeset/pre.json") &&
    changedPaths.length > 0 &&
    changedPaths.every(isGeneratedReleasePath)
  );
}

/** Return the highest stable release heading carried in the generated changelog. */
function findLatestStableRelease(changelog: string) {
  const versions = [...changelog.matchAll(/^## (\d+)\.(\d+)\.(\d+)$/gm)].map((match) => ({
    raw: match[0].slice(3),
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  }));
  versions.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = right.parts[index]! - left.parts[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return versions[0]?.raw;
}

/** Validate the coherent Changesets, package, and changelog state produced for a prerelease. */
export function validateGeneratedPrerelease(input: GeneratedPrereleaseInput) {
  const { packageJson, pre, changelog, changesetIdsOnDisk } = input;
  if (pre.mode !== "pre") {
    throw new Error(`Expected Changesets pre mode, received ${JSON.stringify(pre.mode)}`);
  }

  if (typeof pre.tag !== "string" || !/^[0-9A-Za-z-]+$/.test(pre.tag)) {
    throw new Error("Changesets prerelease tag must be a non-empty npm tag");
  }

  if (!pre.initialVersions || typeof pre.initialVersions !== "object") {
    throw new Error("Changesets prerelease state is missing initialVersions");
  }

  const initialVersion = (pre.initialVersions as Record<string, unknown>)[packageJson.name];
  if (typeof initialVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(initialVersion)) {
    throw new Error(`Missing stable initial version for package ${packageJson.name}`);
  }
  const latestStableRelease = findLatestStableRelease(changelog);
  if (!latestStableRelease) {
    throw new Error("Changelog does not contain a stable release heading");
  }
  if (initialVersion !== latestStableRelease) {
    throw new Error(
      `Initial version ${initialVersion} does not match latest stable release ${latestStableRelease}`,
    );
  }

  const escapedTag = pre.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\d+\\.\\d+\\.\\d+-${escapedTag}\\.\\d+$`).test(packageJson.version)) {
    throw new Error(
      `Package version ${packageJson.version} does not match prerelease tag ${pre.tag}`,
    );
  }

  if (!Array.isArray(pre.changesets) || pre.changesets.length === 0) {
    throw new Error("Changesets prerelease state must record at least one consumed changeset");
  }

  const changesetIds = pre.changesets.filter(
    (changesetId): changesetId is string =>
      typeof changesetId === "string" && /^[0-9A-Za-z-]+$/.test(changesetId),
  );
  if (
    changesetIds.length !== pre.changesets.length ||
    new Set(changesetIds).size !== changesetIds.length
  ) {
    throw new Error("Changesets prerelease state contains invalid or duplicate changeset IDs");
  }

  const missingChangesets = changesetIds.filter(
    (changesetId) => !changesetIdsOnDisk.has(changesetId),
  );
  if (missingChangesets.length > 0) {
    throw new Error(`Missing consumed changeset files: ${missingChangesets.join(", ")}`);
  }

  if (!changelog.split(/\r?\n/).includes(`## ${packageJson.version}`)) {
    throw new Error(`Changelog is missing the ${packageJson.version} release heading`);
  }
}

/** Run Git and return its captured standard output or fail with its diagnostic. */
function readGitOutput(args: string[], root: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit ${result.exitCode}`);
  }
  return result.stdout;
}

/** Read changed paths without relying on shell parsing or platform path separators. */
function readChangedPaths(baseRevision: string, headRevision: string, root: string) {
  const output = readGitOutput(
    ["diff", "--name-only", "--no-renames", "-z", baseRevision, headRevision, "--"],
    root,
  );
  return new TextDecoder().decode(output).split("\0").filter(Boolean);
}

/** Run the normal Changesets status gate for a non-release-preparation pull request. */
function runChangesetStatus(baseRevision: string, root: string) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "changeset:status", "--", `--since=${baseRevision}`],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Changesets status failed with exit ${result.exitCode}`);
  }
}

/** Verify ordinary changesets or the generated state of a metadata-only prerelease PR. */
export async function verifyPrReleaseNotes(
  baseRevision: string,
  headRevision = "HEAD",
  root = repoRoot,
) {
  const changedPaths = readChangedPaths(baseRevision, headRevision, root);
  const prePath = path.join(root, ".changeset", "pre.json");
  if (!isGeneratedPrereleasePreparation(changedPaths) || !existsSync(prePath)) {
    // A stable promotion removes prerelease state and must retain an empty changeset so the normal
    // status gate can distinguish it from an unversioned metadata edit.
    runChangesetStatus(baseRevision, root);
    return "changeset-status" as const;
  }

  const [packageJson, pre, changelog] = await Promise.all([
    Bun.file(
      path.join(root, "packages", "hunk", "package.json"),
    ).json() as Promise<PackageManifest>,
    Bun.file(prePath).json() as Promise<PrereleaseState>,
    Bun.file(path.join(root, "CHANGELOG.md")).text(),
  ]);
  const changesetIdsOnDisk = new Set(
    readdirSync(path.join(root, ".changeset"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)),
  );

  validateGeneratedPrerelease({ packageJson, pre, changelog, changesetIdsOnDisk });
  console.log(`Validated generated prerelease notes for ${packageJson.version}.`);
  return "generated-prerelease" as const;
}

/** Parse command-line revisions before running pull-request release-note verification. */
async function main(args = process.argv.slice(2)) {
  const [baseRevision, headRevision = "HEAD"] = args;
  if (!baseRevision || baseRevision.startsWith("-") || headRevision.startsWith("-")) {
    throw new Error("Usage: verify-pr-release-notes.ts <base-revision> [head-revision]");
  }
  await verifyPrReleaseNotes(baseRevision, headRevision);
}

if (import.meta.main) {
  await main();
}
