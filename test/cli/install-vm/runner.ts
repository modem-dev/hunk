#!/usr/bin/env bun

/**
 * Runs opt-in install compatibility scenarios inside clean Firecracker Linux guests.
 *
 * Normal tests import only the pure contract helpers. Docker, KVM, downloads, package builds,
 * and VM setup begin only from this explicit executable entrypoint.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertDistinctInstallVmRuntimePaths,
  assertSafeCleanTarget,
  assertSafeInstallVmRuntimePath,
  buildControllerImageCommand,
  buildDockerRunCommand,
  buildInstallVmJunit,
  loadScenarioManifest,
  parseInstallVmArgs,
  selectScenarios,
  validateInstallVmPins,
  type InstallVmPins,
  type InstallVmRunResult,
} from "./contract";
import { collectInstallVmPreflightFailures } from "./preflight";
import {
  computeInstallVmFixtureSourceIdentity,
  prepareInstallVmFixtures,
  verifyInstallVmFixtures,
} from "./prepare-fixtures";
import { aggregateInstallVmResults } from "./results";
import { acquireInstallVmRuntimeLock } from "./runtime-lock";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const harnessRoot = import.meta.dir;
const defaultRuntimeRoot = path.join(repoRoot, "tmp", "install-vm");

const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const VM_SUITE_TIMEOUT_MS = 45 * 60 * 1_000;
const TERMINATION_GRACE_MS = 10_000;

export class InstallVmCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

interface HostCommandProcess {
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

interface HostCommandRunnerDependencies {
  spawn: (
    command: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdin: "inherit";
      stdout: "inherit";
      stderr: "inherit";
    },
  ) => HostCommandProcess;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (timer: unknown) => void;
}

/** Runs host commands asynchronously while forwarding interrupts and bounding shutdown. */
export class InstallVmCommandRunner {
  private activeProcess: HostCommandProcess | undefined;
  private interruptedExitCode: number | undefined;
  private terminationTimer: unknown;
  private readonly dependencies: HostCommandRunnerDependencies;

  private readonly handleSigint = () => this.interrupt("SIGINT", 130);
  private readonly handleSigterm = () => this.interrupt("SIGTERM", 143);

  constructor(dependencies: Partial<HostCommandRunnerDependencies> = {}) {
    this.dependencies = {
      spawn: dependencies.spawn ?? ((command, options) => Bun.spawn(command, options)),
      schedule: dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancel:
        dependencies.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
    };
  }

  start() {
    process.once("SIGINT", this.handleSigint);
    process.once("SIGTERM", this.handleSigterm);
  }

  stop() {
    process.off("SIGINT", this.handleSigint);
    process.off("SIGTERM", this.handleSigterm);
    if (this.terminationTimer !== undefined) this.dependencies.cancel(this.terminationTimer);
    this.terminationTimer = undefined;
  }

  private interrupt(signal: NodeJS.Signals, exitCode: number) {
    if (this.interruptedExitCode !== undefined) return;
    this.interruptedExitCode = exitCode;
    this.activeProcess?.kill(signal);
    if (this.activeProcess) {
      if (this.terminationTimer !== undefined) {
        this.dependencies.cancel(this.terminationTimer);
      }
      this.terminationTimer = this.dependencies.schedule(
        () => this.activeProcess?.kill("SIGKILL"),
        TERMINATION_GRACE_MS,
      );
    }
  }

  checkInterrupted() {
    if (this.interruptedExitCode !== undefined) {
      throw new InstallVmCommandError("Install VM suite interrupted.", this.interruptedExitCode);
    }
  }

  async run(command: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
    this.checkInterrupted();
    const proc = this.dependencies.spawn(command, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    this.activeProcess = proc;
    let timedOut = false;
    const timeout = this.dependencies.schedule(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      this.terminationTimer = this.dependencies.schedule(
        () => proc.kill("SIGKILL"),
        TERMINATION_GRACE_MS,
      );
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } finally {
      this.dependencies.cancel(timeout);
      if (this.terminationTimer !== undefined) {
        this.dependencies.cancel(this.terminationTimer);
      }
      this.terminationTimer = undefined;
      this.activeProcess = undefined;
    }

    this.checkInterrupted();
    if (timedOut) {
      throw new InstallVmCommandError(`${command.join(" ")} exceeded its timeout.`, 124);
    }
    if (exitCode !== 0) {
      throw new InstallVmCommandError(
        `${command.join(" ")} failed with exit ${exitCode}`,
        exitCode,
      );
    }
  }
}

/** Compute a stable local image tag from every checked-in controller input. */
function controllerImageTag() {
  const hash = createHash("sha256");
  const files = [
    path.join(harnessRoot, "Dockerfile"),
    path.join(harnessRoot, "controller.sh"),
    path.join(harnessRoot, "pins.json"),
    path.join(harnessRoot, "scenarios.json"),
  ];
  const pending = [
    path.join(harnessRoot, "controller-deps"),
    path.join(harnessRoot, "guest"),
    path.join(harnessRoot, "scenarios"),
  ];
  while (pending.length > 0) {
    const entryPath = pending.pop()!;
    const entries = readdirSync(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(entryPath, entry.name);
      if (entry.isDirectory()) pending.push(child);
      if (entry.isFile()) files.push(child);
    }
  }
  for (const file of files.sort()) {
    hash.update(path.relative(harnessRoot, file));
    hash.update(readFileSync(file));
  }
  return `hunk-install-vm:${hash.digest("hex").slice(0, 12)}`;
}

function writeSkippedResult(
  outputDir: string,
  runId: string,
  startedAt: string,
  scenarios: ReturnType<typeof selectScenarios>,
  sourceIdentity: string,
  reason: string,
) {
  const result: InstallVmRunResult = {
    schemaVersion: 1,
    run: {
      id: runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: "linux-x64",
      sourceIdentity,
      status: "skipped",
      skipReason: reason,
    },
    tools: {},
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      status: "skipped",
      durationMs: 0,
      exitCode: 0,
      commands: [],
      observations: {},
      assertions: [],
      artifacts: [],
    })),
  };
  writeFileSync(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "junit.xml"), buildInstallVmJunit(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Firecracker install suite\n\n⚠️ **Skipped** — ${reason}\n\nResult: \`${path.join(outputDir, "result.json")}\`\n`,
    );
  }
  if (process.env.GITHUB_ACTIONS === "true")
    console.warn(`::warning::Install VM suite skipped: ${reason}`);
}

/** Execute the opt-in VM runner. */
export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallVmArgs(argv);
  const pins: InstallVmPins = validateInstallVmPins(
    JSON.parse(readFileSync(path.join(harnessRoot, "pins.json"), "utf8")),
  );
  const manifest = loadScenarioManifest(path.join(harnessRoot, "scenarios.json"));

  if (options.list) {
    for (const scenario of manifest.scenarios) {
      console.log(`${scenario.id}\t${scenario.description}`);
    }
    return 0;
  }

  mkdirSync(defaultRuntimeRoot, { recursive: true, mode: 0o700 });
  if (options.clean) {
    const target = assertSafeCleanTarget(repoRoot, options.cacheDir ?? defaultRuntimeRoot);
    const releaseLock = acquireInstallVmRuntimeLock(path.join(defaultRuntimeRoot, ".lock"));
    try {
      const revalidatedTarget = assertSafeCleanTarget(repoRoot, target);
      if (revalidatedTarget === defaultRuntimeRoot) {
        for (const entry of readdirSync(revalidatedTarget)) {
          if (entry !== ".lock") {
            rmSync(path.join(revalidatedTarget, entry), { recursive: true, force: true });
          }
        }
      } else {
        rmSync(revalidatedTarget, { recursive: true, force: true });
      }
    } finally {
      releaseLock();
    }
    console.log(`Removed install VM cache and results at ${target}`);
    return 0;
  }

  const selected = selectScenarios(manifest, options.scenarios);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`;
  const startedAt = new Date().toISOString();
  const outputDir = assertSafeInstallVmRuntimePath(
    repoRoot,
    options.outputDir ?? path.join(defaultRuntimeRoot, "runs", runId),
  );
  const cacheDir = assertSafeInstallVmRuntimePath(
    repoRoot,
    options.cacheDir ?? path.join(defaultRuntimeRoot, "cache"),
  );
  const fixtureDir = assertSafeInstallVmRuntimePath(
    repoRoot,
    path.join(defaultRuntimeRoot, "fixtures"),
  );
  assertDistinctInstallVmRuntimePaths({ cacheDir, fixtureDir, outputDir });
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);
  chmodSync(cacheDir, 0o700);

  const sourceIdentity = computeInstallVmFixtureSourceIdentity(repoRoot);
  const failures = await collectInstallVmPreflightFailures(defaultRuntimeRoot);
  if (failures.length > 0) {
    const reason = failures.join(" ");
    if (options.allowSkip) {
      writeSkippedResult(outputDir, runId, startedAt, selected, sourceIdentity, reason);
      console.warn(`Skipped install VM suite: ${reason}`);
      console.warn(`Result: ${path.join(outputDir, "result.json")}`);
      return 0;
    }
    throw new Error(`Install VM preflight failed:\n- ${failures.join("\n- ")}`);
  }

  const releaseLock = acquireInstallVmRuntimeLock(path.join(defaultRuntimeRoot, ".lock"));
  const commandRunner = new InstallVmCommandRunner();
  commandRunner.start();
  try {
    let fixturesReusable = false;
    if (options.reuseFixtures && existsSync(path.join(fixtureDir, "fixture-manifest.json"))) {
      try {
        verifyInstallVmFixtures(repoRoot, fixtureDir);
        fixturesReusable = true;
        console.log("Reusing checksum-verified install VM fixtures for this checkout.");
      } catch (error) {
        console.warn(
          `Rejected stale install VM fixtures: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (!fixturesReusable) {
      await commandRunner.run([process.execPath, "run", "build:prebuilt:npm"]);
      await prepareInstallVmFixtures(repoRoot, fixtureDir);
    }

    const image = controllerImageTag();
    await commandRunner.run(buildControllerImageCommand(image, harnessRoot, pins));
    const revalidatedPaths = {
      cacheDir: assertSafeInstallVmRuntimePath(repoRoot, cacheDir),
      fixtureDir: assertSafeInstallVmRuntimePath(repoRoot, fixtureDir),
      outputDir: assertSafeInstallVmRuntimePath(repoRoot, outputDir),
    };
    assertDistinctInstallVmRuntimePaths(revalidatedPaths);
    const fixtureManifest = verifyInstallVmFixtures(repoRoot, revalidatedPaths.fixtureDir);
    if (fixtureManifest.sourceIdentity !== sourceIdentity) {
      throw new Error("Install VM checkout changed while the suite was preparing fixtures.");
    }
    const dockerCommand = buildDockerRunCommand(
      image,
      revalidatedPaths,
      selected.map((scenario) => scenario.id),
      { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    );
    await commandRunner.run(dockerCommand, { timeoutMs: VM_SUITE_TIMEOUT_MS });

    const tools = JSON.parse(readFileSync(path.join(outputDir, "tools.json"), "utf8")) as Record<
      string,
      string
    >;
    if (tools.pnpm !== pins.pnpmVersion) {
      throw new Error(
        `Guest pnpm version drifted: expected ${pins.pnpmVersion}, got ${tools.pnpm}`,
      );
    }
    if (computeInstallVmFixtureSourceIdentity(repoRoot) !== sourceIdentity) {
      throw new Error("Install VM checkout changed while the suite was running.");
    }
    commandRunner.checkInterrupted();
    const result = aggregateInstallVmResults({
      outputDir,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceIdentity,
      scenarios: selected,
      tools,
    });
    console.log(`Install VM result: ${path.join(outputDir, "result.json")}`);
    console.log(`Install VM JUnit: ${path.join(outputDir, "junit.xml")}`);
    commandRunner.checkInterrupted();
    return result.run.status === "passed" ? 0 : 1;
  } finally {
    commandRunner.stop();
    releaseLock();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof InstallVmCommandError ? error.exitCode : 1;
  }
}
