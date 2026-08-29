import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildInstallVmJunit,
  type InstallVmAssertion,
  type InstallVmCommandResult,
  type InstallVmRunResult,
  type InstallVmScenarioObservations,
  type InstallVmScenario,
  type InstallVmScenarioResult,
} from "./contract";

interface RawScenarioResult {
  id: string;
  exitCode: number;
  durationMs: number;
}

const RESULT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/** Return one safe relative artifact path, rejecting traversal and absolute paths. */
function safeArtifactPath(value: string) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized !== value || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe install VM artifact path: ${value}`);
  }
  return normalized;
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
      return { id, status, expectation, exitCode, logPath: safeArtifactPath(logPath) };
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

/** Aggregate bounded scenario result files into stable JSON and JUnit artifacts. */
export function aggregateInstallVmResults(options: {
  outputDir: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
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
