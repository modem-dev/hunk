#!/usr/bin/env bun

/** Validates Firecracker release evidence against the current checkout and full scenario manifest. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadScenarioManifest, selectScenarios, validateInstallVmPins } from "./contract";
import {
  computeDaemonUpgradeBuildInputIdentity,
  readDaemonRevision,
} from "./prepare-daemon-upgrade-fixtures";
import {
  computeInstallVmFixtureSourceIdentity,
  deriveVerifiedDaemonUpgradeBinaryDigests,
  verifyInstallVmFixtures,
} from "./prepare-fixtures";
import { validateInstallVmReleaseResult } from "./results";
import { resolveHunkProtocolPath } from "./repo-layout";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const resultPath = process.argv[2];
const targetedScenario = process.argv[3] === "--scenario" ? process.argv[4] : undefined;
if (
  !resultPath ||
  (process.argv.length !== 3 &&
    !(process.argv.length === 5 && process.argv[3] === "--scenario" && targetedScenario))
) {
  throw new Error("Usage: validate-release-result.ts <result.json> [--scenario <id>]");
}

const manifest = loadScenarioManifest(path.join(import.meta.dir, "scenarios.json"));
const pins = validateInstallVmPins(
  JSON.parse(readFileSync(path.join(import.meta.dir, "pins.json"), "utf8")),
);
const resolvedResultPath = path.resolve(resultPath);
const scenarios = targetedScenario
  ? selectScenarios(manifest, [targetedScenario])
  : manifest.scenarios;
let daemonUpgradeBinaryDigests;
let daemonUpgradeBuildInputIdentity;
let daemonRevision;
if (scenarios.some((scenario) => scenario.id === "authenticated-daemon-upgrade")) {
  const fixtureDirectory = path.join(repoRoot, "tmp", "install-vm", "fixtures");
  let fixtureManifest;
  try {
    fixtureManifest = verifyInstallVmFixtures(repoRoot, fixtureDirectory);
  } catch (error) {
    throw new Error(
      `Trusted install VM fixture set is missing or stale: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    daemonUpgradeBinaryDigests = await deriveVerifiedDaemonUpgradeBinaryDigests(
      fixtureDirectory,
      fixtureManifest,
    );
  } catch (error) {
    throw new Error(
      `Trusted install VM fixture binaries are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  daemonUpgradeBuildInputIdentity = computeDaemonUpgradeBuildInputIdentity(repoRoot);
  daemonRevision = readDaemonRevision(readFileSync(resolveHunkProtocolPath(repoRoot), "utf8"));
}
const result = validateInstallVmReleaseResult(
  JSON.parse(readFileSync(resolvedResultPath, "utf8")),
  {
    sourceIdentity: computeInstallVmFixtureSourceIdentity(repoRoot),
    pnpmVersion: pins.pnpmVersion,
    scenarios,
    resultDirectory: path.dirname(resolvedResultPath),
    daemonUpgradeBuildInputIdentity,
    daemonRevision,
    daemonUpgradeBinaryDigests,
  },
);
console.log(
  `Validated ${targetedScenario ? "targeted" : "complete"} install VM evidence for ${result.scenarios.length} scenario(s) and source ${result.run.sourceIdentity}.`,
);
