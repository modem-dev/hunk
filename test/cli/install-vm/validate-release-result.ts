#!/usr/bin/env bun

/** Validates Firecracker release evidence against the current checkout and full scenario manifest. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadScenarioManifest, validateInstallVmPins } from "./contract";
import { computeInstallVmFixtureSourceIdentity } from "./prepare-fixtures";
import { validateInstallVmReleaseResult } from "./results";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const resultPath = process.argv[2];
if (!resultPath || process.argv.length !== 3) {
  throw new Error("Usage: validate-release-result.ts <result.json>");
}

const manifest = loadScenarioManifest(path.join(import.meta.dir, "scenarios.json"));
const pins = validateInstallVmPins(
  JSON.parse(readFileSync(path.join(import.meta.dir, "pins.json"), "utf8")),
);
const result = validateInstallVmReleaseResult(JSON.parse(readFileSync(resultPath, "utf8")), {
  sourceIdentity: computeInstallVmFixtureSourceIdentity(repoRoot),
  pnpmVersion: pins.pnpmVersion,
  scenarios: manifest.scenarios,
});
console.log(
  `Validated ${result.scenarios.length} install VM scenarios for source ${result.run.sourceIdentity}.`,
);
