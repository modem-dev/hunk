import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  buildInstallVmJunit,
  validateInstallVmCommandExpectation,
  type InstallVmAssertion,
  type InstallVmCommandResult,
  type InstallVmRunResult,
  type InstallVmScenarioObservations,
  type InstallVmScenario,
  type InstallVmScenarioResult,
} from "./contract";
import {
  DAEMON_UPGRADE_VERSION_A,
  DAEMON_UPGRADE_VERSION_B,
} from "./prepare-daemon-upgrade-fixtures";

interface RawScenarioResult {
  id: string;
  exitCode: number;
  durationMs: number;
}

const RESULT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const SOURCE_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

/** Return one safe relative artifact path, rejecting traversal and absolute paths. */
function safeArtifactPath(value: string) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe install VM artifact path: ${value}`);
  }
  return normalized;
}

/** Resolve an artifact without allowing any symlink component or root escape. */
function containedArtifact(
  root: string,
  relativePath: string,
  expectedKind: "file" | "directory" | "either" = "either",
) {
  const safe = safeArtifactPath(relativePath);
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const segment of safe.split("/")) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Install VM artifact may not be a symlink: ${safe}`);
  }
  const resolved = realpathSync(current);
  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Install VM artifact escapes its run directory: ${safe}`);
  }
  const stat = lstatSync(resolved);
  if (expectedKind === "file" && !stat.isFile()) {
    throw new Error(`Install VM artifact is not a regular file: ${safe}`);
  }
  if (expectedKind === "directory" && !stat.isDirectory()) {
    throw new Error(`Install VM artifact is not a directory: ${safe}`);
  }
  return resolved;
}

/** Parse guest assertion TSV without allowing embedded control fields. */
export function parseAssertionTsv(contents: string): InstallVmAssertion[] {
  if (!contents.trim()) return [];
  return contents
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const fields = line.split("\t");
      if (fields.length !== 5) throw new Error(`Malformed assertion TSV line ${index + 1}.`);
      const [id, status, expected, actual, message] = fields as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid assertion id: ${id}`);
      if (status !== "passed" && status !== "failed") {
        throw new Error(`Invalid assertion status for ${id}: ${status}`);
      }
      return { id, status, expected, actual, message };
    });
}

/** Parse guest command TSV into bounded references to full command logs. */
export function parseCommandTsv(contents: string): InstallVmCommandResult[] {
  if (!contents.trim()) return [];
  return contents
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const fields = line.split("\t");
      if (fields.length !== 5) throw new Error(`Malformed command TSV line ${index + 1}.`);
      const [id, status, expectation, exitCodeText, logPath] = fields as [
        string,
        string,
        string,
        string,
        string,
      ];
      const exitCode = Number(exitCodeText);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid command id: ${id}`);
      if (status !== "passed" && status !== "failed") {
        throw new Error(`Invalid command status for ${id}: ${status}`);
      }
      if (!Number.isSafeInteger(exitCode)) throw new Error(`Invalid command exit code for ${id}.`);
      return {
        id,
        status,
        expectation,
        exitCode,
        logPath: safeArtifactPath(logPath),
      };
    });
}

/** Parse guest observations without allowing duplicate or unsafe keys. */
export function parseObservationTsv(contents: string): InstallVmScenarioObservations {
  const observations: InstallVmScenarioObservations = {};
  if (!contents.trim()) return observations;
  for (const [index, line] of contents.trimEnd().split("\n").entries()) {
    const fields = line.split("\t");
    if (fields.length !== 2) throw new Error(`Malformed observation TSV line ${index + 1}.`);
    const [key, value] = fields as [string, string];
    if (!RESULT_KEY_PATTERN.test(key)) throw new Error(`Invalid observation key: ${key}`);
    if (observations[key] !== undefined) throw new Error(`Duplicate observation key: ${key}`);
    observations[key] = key.endsWith("Path") ? safeArtifactPath(value) : value;
  }
  return observations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyStringValues(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function hasUniqueIds(records: readonly Record<string, unknown>[]) {
  const ids = records.map((record) => record.id);
  return ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
}

/** Require each scenario-declared proof item to exist exactly once and be successful/nonempty. */
function validateRequiredEvidence(
  scenario: InstallVmScenario,
  evidence: {
    commands: readonly { id: string; status: string; expectation: string }[];
    assertions: readonly { id: string; status: string }[];
    observations: Readonly<Record<string, string | undefined>>;
  },
) {
  for (const id of scenario.requiredEvidence?.commands ?? []) {
    const matches = evidence.commands.filter((command) => command.id === id);
    if (matches.length !== 1 || matches[0]?.status !== "passed") {
      throw new Error(`Install VM scenario ${scenario.id} is missing required command ${id}.`);
    }
    const expectedExpectation = scenario.requiredEvidence?.commandExpectations?.[id];
    if (expectedExpectation !== undefined && matches[0]?.expectation !== expectedExpectation) {
      throw new Error(
        `Install VM scenario ${scenario.id} command ${id} expected ${expectedExpectation}, got ${matches[0]?.expectation}.`,
      );
    }
  }
  for (const id of scenario.requiredEvidence?.assertions ?? []) {
    const matches = evidence.assertions.filter((assertion) => assertion.id === id);
    if (matches.length !== 1 || matches[0]?.status !== "passed") {
      throw new Error(`Install VM scenario ${scenario.id} is missing required assertion ${id}.`);
    }
  }
  for (const key of scenario.requiredEvidence?.observations ?? []) {
    const value = evidence.observations[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Install VM scenario ${scenario.id} is missing required observation ${key}.`);
    }
  }
}

const DAEMON_UPGRADE_SCENARIO_ID = "authenticated-daemon-upgrade";
const DAEMON_UPGRADE_WARNING = "Close older Hunk windows";
const MAX_DAEMON_RECONNECT_DURATION_MS = 120_000;

/** Parse one required positive integer observation. */
function positiveObservation(observations: Record<string, string>, key: string) {
  const value = Number(observations[key]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Authenticated daemon upgrade has invalid ${key}.`);
  }
  return value;
}

/** Read one scenario artifact beneath the validated run directory. */
function readScenarioArtifact(resultDirectory: string, scenarioId: string, relativePath: string) {
  const safeRelativePath = safeArtifactPath(relativePath);
  try {
    return readFileSync(
      containedArtifact(
        resultDirectory,
        path.posix.join("scenarios", scenarioId, safeRelativePath),
        "file",
      ),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Install VM artifact")) throw error;
    throw new Error(`Install VM scenario ${scenarioId} is missing artifact ${safeRelativePath}.`);
  }
}

/** Validate the daemon migration scenario's process and protocol evidence from guest artifacts. */
function validateAuthenticatedDaemonUpgradeEvidence(
  scenario: Record<string, unknown>,
  resultDirectory: string,
  runSourceIdentity: string,
  expectedBuildInputIdentity?: string,
  expectedDaemonRevision?: number,
  expectedBinaryDigests?: { readonly binarySha256A: string; readonly binarySha256B: string },
) {
  const observations = scenario.observations as Record<string, string>;
  if (
    observations.daemonPackageVersionA !== DAEMON_UPGRADE_VERSION_A ||
    observations.daemonPackageVersionB !== DAEMON_UPGRADE_VERSION_B
  ) {
    throw new Error("Authenticated daemon upgrade fixture versions are not fixed.");
  }
  const revisionA = positiveObservation(observations, "daemonRevisionA");
  const revisionB = positiveObservation(observations, "daemonRevisionB");
  if (revisionB !== revisionA + 1) {
    throw new Error("Authenticated daemon upgrade revisions must be adjacent.");
  }
  if (expectedDaemonRevision !== undefined && revisionB !== expectedDaemonRevision) {
    throw new Error("Authenticated daemon upgrade revision does not match this checkout.");
  }

  const oldDaemonPid = positiveObservation(observations, "oldDaemonPid");
  const oldDaemonStartToken = positiveObservation(observations, "oldDaemonStartToken");
  const newDaemonPid = positiveObservation(observations, "newDaemonPid");
  const newDaemonStartToken = positiveObservation(observations, "newDaemonStartToken");
  if (oldDaemonPid === newDaemonPid && oldDaemonStartToken === newDaemonStartToken) {
    throw new Error("Authenticated daemon upgrade reused the incumbent process identity.");
  }
  const oldClientPid = positiveObservation(observations, "oldClientPid");
  const newFirstClientPid = positiveObservation(observations, "newFirstClientPid");
  const newSecondClientPid = positiveObservation(observations, "newSecondClientPid");
  positiveObservation(observations, "oldClientStartToken");
  positiveObservation(observations, "newFirstClientStartToken");
  positiveObservation(observations, "newSecondClientStartToken");
  positiveObservation(observations, "newFirstWrapperStartToken");
  positiveObservation(observations, "newSecondWrapperStartToken");

  const oldDigest = observations.oldExecutableDigest ?? "";
  const newDigest = observations.newExecutableDigest ?? "";
  if (
    !SOURCE_IDENTITY_PATTERN.test(oldDigest) ||
    !SOURCE_IDENTITY_PATTERN.test(newDigest) ||
    oldDigest === newDigest
  ) {
    throw new Error("Authenticated daemon upgrade executable digests are invalid or equal.");
  }
  const parseExecutableEvidence = (key: "oldExecutablePath" | "newExecutablePath") => {
    const fields = Object.fromEntries(
      readScenarioArtifact(resultDirectory, DAEMON_UPGRADE_SCENARIO_ID, observations[key]!)
        .trimEnd()
        .split("\n")
        .map((line) => {
          const index = line.indexOf("=");
          if (index < 1) throw new Error(`Authenticated daemon upgrade ${key} is malformed.`);
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    if (
      Object.keys(fields).sort().join("\0") !==
      ["digest", "location", "pid", "startToken"].join("\0")
    ) {
      throw new Error(`Authenticated daemon upgrade ${key} is malformed.`);
    }
    return fields;
  };
  const oldExecutable = parseExecutableEvidence("oldExecutablePath");
  const newExecutable = parseExecutableEvidence("newExecutablePath");
  for (const [evidence, pid, token, location, digest, key] of [
    [
      oldExecutable,
      oldDaemonPid,
      oldDaemonStartToken,
      observations.oldExecutableLocation,
      oldDigest,
      "oldExecutablePath",
    ],
    [
      newExecutable,
      newDaemonPid,
      newDaemonStartToken,
      observations.newExecutableLocation,
      newDigest,
      "newExecutablePath",
    ],
  ] as const) {
    if (
      evidence.pid !== String(pid) ||
      evidence.startToken !== String(token) ||
      evidence.location !== location ||
      evidence.digest !== digest
    ) {
      throw new Error(`Authenticated daemon upgrade ${key} does not match observations.`);
    }
  }
  const fixtureManifest = JSON.parse(
    readScenarioArtifact(
      resultDirectory,
      DAEMON_UPGRADE_SCENARIO_ID,
      observations.fixtureManifestPath!,
    ),
  ) as Record<string, unknown>;
  const fixtureUpgrade = fixtureManifest.daemonUpgrade as Record<string, unknown> | undefined;
  const buildInputIdentity = fixtureManifest.daemonUpgradeBuildInputIdentity;
  if (
    fixtureManifest.sourceIdentity !== runSourceIdentity ||
    fixtureManifest.schemaVersion !== 2 ||
    !isRecord(fixtureUpgrade) ||
    Object.keys(fixtureUpgrade).sort().join("\0") !==
      ["binarySha256A", "binarySha256B", "revisionA", "revisionB", "versionA", "versionB"].join(
        "\0",
      ) ||
    fixtureUpgrade.versionA !== DAEMON_UPGRADE_VERSION_A ||
    fixtureUpgrade.versionB !== DAEMON_UPGRADE_VERSION_B ||
    fixtureUpgrade.revisionA !== revisionA ||
    fixtureUpgrade.revisionB !== revisionB ||
    fixtureUpgrade.binarySha256A !== oldDigest ||
    fixtureUpgrade.binarySha256B !== newDigest ||
    expectedBinaryDigests?.binarySha256A !== oldDigest ||
    expectedBinaryDigests?.binarySha256B !== newDigest ||
    typeof buildInputIdentity !== "string" ||
    !SOURCE_IDENTITY_PATTERN.test(buildInputIdentity) ||
    observations.daemonUpgradeBuildInputIdentity !== buildInputIdentity ||
    (expectedBuildInputIdentity !== undefined && buildInputIdentity !== expectedBuildInputIdentity)
  ) {
    throw new Error(
      "Authenticated daemon upgrade fixture manifest does not match release evidence.",
    );
  }

  const reconnectDuration = positiveObservation(observations, "reconnectDurationMs");
  if (reconnectDuration > MAX_DAEMON_RECONNECT_DURATION_MS) {
    throw new Error("Authenticated daemon upgrade reconnect duration exceeds its bound.");
  }

  for (const key of ["overlapHealthPath", "recoveredHealthPath"] as const) {
    if (
      readScenarioArtifact(resultDirectory, DAEMON_UPGRADE_SCENARIO_ID, observations[key]!) !==
      '{"ok":true}'
    ) {
      throw new Error(`Authenticated daemon upgrade ${key} is not exact minimal health.`);
    }
  }
  for (const [key, expectedPid] of [
    ["oldMetadataPath", oldDaemonPid],
    ["recoveredMetadataPath", newDaemonPid],
  ] as const) {
    const metadata = JSON.parse(
      readScenarioArtifact(resultDirectory, DAEMON_UPGRADE_SCENARIO_ID, observations[key]!),
    ) as { pid?: unknown };
    if (metadata.pid !== expectedPid) {
      throw new Error(`Authenticated daemon upgrade ${key} PID does not match observations.`);
    }
  }

  const readSessionPids = (
    key: "oldSessionListPath" | "firstRecoveredSessionListPath" | "recoveredSessionListPath",
  ) => {
    const value = JSON.parse(
      readScenarioArtifact(resultDirectory, DAEMON_UPGRADE_SCENARIO_ID, observations[key]!),
    ) as { sessions?: Array<{ pid?: unknown }> };
    if (!Array.isArray(value.sessions) || value.sessions.some((entry) => !isRecord(entry))) {
      throw new Error(`Authenticated daemon upgrade ${key} has malformed sessions.`);
    }
    return value.sessions
      .map((entry) => entry.pid)
      .sort((left, right) => Number(left) - Number(right));
  };
  if (JSON.stringify(readSessionPids("oldSessionListPath")) !== JSON.stringify([oldClientPid])) {
    throw new Error("Authenticated daemon upgrade old session PID does not match its client.");
  }
  if (
    JSON.stringify(readSessionPids("firstRecoveredSessionListPath")) !==
    JSON.stringify([newFirstClientPid])
  ) {
    throw new Error(
      "Authenticated daemon upgrade first successor session is not its original client.",
    );
  }
  const recoveredPids = [newFirstClientPid, newSecondClientPid].sort((left, right) => left - right);
  if (
    JSON.stringify(readSessionPids("recoveredSessionListPath")) !== JSON.stringify(recoveredPids)
  ) {
    throw new Error(
      "Authenticated daemon upgrade recovered session PIDs are not the original clients.",
    );
  }
  if (
    !readScenarioArtifact(
      resultDirectory,
      DAEMON_UPGRADE_SCENARIO_ID,
      observations.incompatibleWarningPath!,
    ).includes(DAEMON_UPGRADE_WARNING)
  ) {
    throw new Error("Authenticated daemon upgrade warning evidence is missing required guidance.");
  }
}

/** Validate that release evidence is complete, consistent, and matches this checkout. */
export function validateInstallVmReleaseResult(
  value: unknown,
  expected: {
    sourceIdentity: string;
    pnpmVersion: string;
    scenarios: readonly InstallVmScenario[];
    resultDirectory?: string;
    daemonUpgradeBuildInputIdentity?: string;
    daemonRevision?: number;
    daemonUpgradeBinaryDigests?: {
      readonly binarySha256A: string;
      readonly binarySha256B: string;
    };
  },
) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.run)) {
    throw new Error("Install VM result must use schemaVersion 1 and contain run evidence.");
  }
  const run = value.run;
  if (
    typeof run.id !== "string" ||
    run.id.length === 0 ||
    typeof run.startedAt !== "string" ||
    !Number.isFinite(Date.parse(run.startedAt)) ||
    typeof run.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(run.finishedAt)) ||
    Date.parse(run.finishedAt) < Date.parse(run.startedAt) ||
    run.platform !== "linux-x64" ||
    run.skipReason !== undefined
  ) {
    throw new Error("Install VM result has malformed run metadata.");
  }
  if (
    !SOURCE_IDENTITY_PATTERN.test(expected.sourceIdentity) ||
    run.sourceIdentity !== expected.sourceIdentity
  ) {
    throw new Error("Install VM result does not match the current checkout identity.");
  }
  if (run.status !== "passed") {
    throw new Error(`Install VM release result is ${String(run.status)}, not passed.`);
  }
  const expectedToolKeys = ["firecracker", "kernel", "node", "npm", "pnpm", "verdaccio"];
  if (
    !hasOnlyStringValues(value.tools) ||
    Object.keys(value.tools).sort().join("\0") !== expectedToolKeys.join("\0") ||
    Object.values(value.tools).some((tool) => tool.trim().length === 0) ||
    value.tools.pnpm !== expected.pnpmVersion
  ) {
    throw new Error("Install VM release result has malformed or drifted tool evidence.");
  }
  if (!Array.isArray(value.scenarios)) {
    throw new Error("Install VM release result has no scenario evidence.");
  }

  const scenarioRecords = value.scenarios.filter(isRecord);
  if (scenarioRecords.length !== value.scenarios.length || !hasUniqueIds(scenarioRecords)) {
    throw new Error("Install VM release result has malformed or duplicate scenarios.");
  }
  const expectedById = new Map(expected.scenarios.map((scenario) => [scenario.id, scenario]));
  const expectedIds = [...expectedById.keys()].sort();
  const actualIds = scenarioRecords.map((scenario) => scenario.id as string).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Install VM release result does not cover the complete scenario manifest.");
  }

  for (const scenario of scenarioRecords) {
    const id = scenario.id as string;
    const definition = expectedById.get(id)!;
    if (
      scenario.description !== definition.description ||
      scenario.status !== "passed" ||
      scenario.exitCode !== 0 ||
      !Number.isSafeInteger(scenario.durationMs) ||
      (scenario.durationMs as number) < 0 ||
      !Array.isArray(scenario.commands) ||
      scenario.commands.length === 0 ||
      !Array.isArray(scenario.assertions) ||
      scenario.assertions.length === 0 ||
      !hasOnlyStringValues(scenario.observations) ||
      !Array.isArray(scenario.artifacts) ||
      scenario.artifacts.length === 0
    ) {
      throw new Error(`Install VM release result has incomplete evidence for ${id}.`);
    }

    for (const [key, observation] of Object.entries(scenario.observations)) {
      if (!RESULT_KEY_PATTERN.test(key)) {
        throw new Error(`Install VM release result has malformed observations for ${id}.`);
      }
      if (key.endsWith("Path")) safeArtifactPath(observation);
    }

    const commandRecords = scenario.commands.filter(isRecord);
    if (commandRecords.length !== scenario.commands.length || !hasUniqueIds(commandRecords)) {
      throw new Error(`Install VM release result has malformed commands for ${id}.`);
    }
    for (const command of commandRecords) {
      if (
        typeof command.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.id) ||
        command.status !== "passed" ||
        typeof command.expectation !== "string" ||
        !Number.isSafeInteger(command.exitCode) ||
        typeof command.logPath !== "string"
      ) {
        throw new Error(`Install VM release result has malformed command evidence for ${id}.`);
      }
      safeArtifactPath(command.logPath);
      validateInstallVmCommandExpectation(command.expectation, command.exitCode as number);
    }

    const assertionRecords = scenario.assertions.filter(isRecord);
    if (assertionRecords.length !== scenario.assertions.length || !hasUniqueIds(assertionRecords)) {
      throw new Error(`Install VM release result has malformed assertions for ${id}.`);
    }
    for (const assertion of assertionRecords) {
      if (
        typeof assertion.id !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assertion.id) ||
        assertion.status !== "passed" ||
        typeof assertion.expected !== "string" ||
        typeof assertion.actual !== "string" ||
        typeof assertion.message !== "string"
      ) {
        throw new Error(`Install VM release result has malformed assertion evidence for ${id}.`);
      }
    }
    for (const artifact of scenario.artifacts) {
      if (typeof artifact !== "string") {
        throw new Error(`Install VM release result has malformed artifacts for ${id}.`);
      }
      const relativePath = safeArtifactPath(artifact);
      if (expected.resultDirectory) {
        try {
          containedArtifact(expected.resultDirectory, relativePath);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Install VM artifact"))
            throw error;
          throw new Error(`Install VM release result references missing artifact ${relativePath}.`);
        }
      }
    }
    if (expected.resultDirectory) {
      for (const command of commandRecords as Array<{
        logPath: string;
        expectation: string;
        exitCode: number;
        status: string;
      }>) {
        const declaredPath = path.posix.join("scenarios", id, command.logPath);
        const declared = (scenario.artifacts as string[]).some(
          (artifact) => artifact === declaredPath || declaredPath.startsWith(`${artifact}/`),
        );
        if (!declared) throw new Error(`Install VM command log is not declared: ${declaredPath}.`);
        containedArtifact(expected.resultDirectory, declaredPath, "file");
      }
    }
    validateRequiredEvidence(definition, {
      commands: commandRecords as Array<{ id: string; status: string; expectation: string }>,
      assertions: assertionRecords as Array<{ id: string; status: string }>,
      observations: scenario.observations as Record<string, string>,
    });
    for (const key of definition.requiredEvidence?.observations ?? []) {
      if (!key.endsWith("Path")) continue;
      const relativePath = (scenario.observations as Record<string, string>)[key]!;
      const expectedArtifact = path.posix.join("scenarios", id, relativePath);
      if (!(scenario.artifacts as string[]).includes(expectedArtifact)) {
        throw new Error(`Install VM scenario ${id} is missing required path artifact ${key}.`);
      }
    }
    if (id === DAEMON_UPGRADE_SCENARIO_ID) {
      if (!expected.resultDirectory) {
        throw new Error("Authenticated daemon upgrade validation requires its run directory.");
      }
      validateAuthenticatedDaemonUpgradeEvidence(
        scenario,
        expected.resultDirectory,
        value.run.sourceIdentity as string,
        expected.daemonUpgradeBuildInputIdentity,
        expected.daemonRevision,
        expected.daemonUpgradeBinaryDigests,
      );
    }
  }

  return value as unknown as InstallVmRunResult;
}

/** Aggregate bounded scenario result files into stable JSON and JUnit artifacts. */
export function aggregateInstallVmResults(options: {
  outputDir: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  sourceIdentity: string;
  scenarios: readonly InstallVmScenario[];
  tools: Record<string, string>;
  skipReason?: string;
}) {
  const scenarioResults: InstallVmScenarioResult[] = options.scenarios.map((scenario) => {
    const directory = path.join(options.outputDir, "scenarios", scenario.id);
    const raw = JSON.parse(
      readFileSync(path.join(directory, "result.json"), "utf8"),
    ) as RawScenarioResult;
    if (
      raw.id !== scenario.id ||
      !Number.isSafeInteger(raw.exitCode) ||
      !Number.isSafeInteger(raw.durationMs) ||
      raw.durationMs < 0
    ) {
      throw new Error(`Malformed raw scenario result for ${scenario.id}.`);
    }
    const assertionsPath = path.join(directory, "assertions.tsv");
    const assertions = parseAssertionTsv(readFileSync(assertionsPath, "utf8"));
    const commands = parseCommandTsv(readFileSync(path.join(directory, "commands.tsv"), "utf8"));
    const observations = parseObservationTsv(
      readFileSync(path.join(directory, "observations.tsv"), "utf8"),
    );
    for (const command of commands) {
      if (!existsSync(path.join(directory, command.logPath))) {
        throw new Error(`Missing command log for ${scenario.id}/${command.id}.`);
      }
    }
    for (const [key, value] of Object.entries(observations)) {
      if (key.endsWith("Path") && value !== undefined && !existsSync(path.join(directory, value))) {
        throw new Error(`Missing observation artifact for ${scenario.id}/${key}.`);
      }
    }
    if (assertions.length === 0) {
      assertions.push({
        id: "guest-assertions",
        status: "failed",
        expected: "at least one assertion",
        actual: "none",
        message: "guest returned no assertion evidence",
      });
    }
    if (commands.length === 0) {
      assertions.push({
        id: "guest-commands",
        status: "failed",
        expected: "at least one command",
        actual: "none",
        message: "guest returned no command evidence",
      });
    }
    try {
      validateRequiredEvidence(scenario, {
        commands,
        assertions,
        observations,
      });
    } catch (error) {
      assertions.push({
        id: "required-evidence",
        status: "failed",
        expected: "complete declared evidence",
        actual: "missing",
        message: error instanceof Error ? error.message : "required evidence missing",
      });
    }
    const artifacts = readdirSync(directory)
      .filter(
        (entry) =>
          !entry.endsWith(".ext4") &&
          !entry.endsWith(".socket") &&
          !entry.startsWith("id_") &&
          !entry.includes("credential") &&
          !entry.includes("identity"),
      )
      .sort()
      .map((entry) => path.posix.join("scenarios", scenario.id, entry));
    const failed =
      raw.exitCode !== 0 ||
      assertions.some((assertion) => assertion.status === "failed") ||
      commands.some((command) => command.status === "failed");
    return {
      id: scenario.id,
      description: scenario.description,
      status: failed ? "failed" : "passed",
      durationMs: raw.durationMs,
      exitCode: raw.exitCode,
      commands,
      observations,
      assertions,
      artifacts,
    };
  });

  const status = options.skipReason
    ? "skipped"
    : scenarioResults.some((scenario) => scenario.status === "failed")
      ? "failed"
      : "passed";
  const result: InstallVmRunResult = {
    schemaVersion: 1,
    run: {
      id: options.runId,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      platform: "linux-x64",
      sourceIdentity: options.sourceIdentity,
      status,
      ...(options.skipReason ? { skipReason: options.skipReason } : {}),
    },
    tools: Object.fromEntries(
      Object.entries(options.tools).sort(([left], [right]) => left.localeCompare(right)),
    ),
    scenarios: scenarioResults.sort((left, right) => left.id.localeCompare(right.id)),
  };

  writeFileSync(
    path.join(options.outputDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(path.join(options.outputDir, "junit.xml"), buildInstallVmJunit(result));
  return result;
}
