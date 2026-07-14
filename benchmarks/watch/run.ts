#!/usr/bin/env bun

import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { rawResultPath, terminalLogPath, writeRawRecord } from "./artifacts";
import {
  atomicRenameTrackedWrite,
  ordinaryTrackedWrite,
  readFixtureManifest,
  reconstructFixture,
  relevantUntrackedCreation,
  resetFixtureState,
  startupLaunchOrder,
  verifyFixtureArtifacts,
  type FixtureManifest,
  type MutationObserver,
} from "./fixture";
import { createGitTrace2Environment, finalizeGitTrace2Activity } from "./git-log";
import { assertWatchHostIdentity } from "./host-identity";
import { launchObserverProbe } from "./observer-probe";
import { renderWatchMarkdown } from "./report";
import { collectIdleSamples } from "./sampler";
import {
  WATCH_PROTOCOL_VERSION,
  WATCH_TERMINAL_GEOMETRY,
  collectHostMetadata,
  fileSha256,
  readCampaignConfig,
  verifyBinaryProvenance,
  watchRunRecordSchema,
  type BenchmarkRevision,
  type CampaignConfig,
  type FixtureRecord,
  type ObserverMetrics,
  type VerifiedBinary,
  type WatchRunKind,
  type WatchRunRecord,
} from "./schema";
import { launchWatchTerminal, terminalScreenParser, type WatchTerminalSession } from "./terminal";

interface PreparedFixture {
  config: CampaignConfig["fixtures"][number];
  manifest: FixtureManifest;
  record: FixtureRecord;
}

interface RunMeasurements {
  startup: WatchRunRecord["startup"];
  idle: WatchRunRecord["idle"];
  gitActivity: WatchRunRecord["gitActivity"];
  refresh: WatchRunRecord["refresh"];
  cleanupComplete: boolean;
  errors?: WatchRunRecord["errors"];
  terminalBytes?: Uint8Array;
  observer?: ObserverMetrics;
}

interface RunDescriptor {
  fixture: PreparedFixture;
  revision: BenchmarkRevision;
  runKind: WatchRunKind;
  trial: number;
  orderIndex: number;
  startupLaunchIndex: number | null;
  cacheLabel: "cold-ish" | "warm";
  warmup: boolean;
}

const LEGACY_OBSERVER: ObserverMetrics = {
  metricLabel: "probe process launch -> observer ready",
  observerReadyStatus: "not-applicable-legacy-polling",
  observerReadyMs: null,
  planDerivationMs: null,
  constructionToReadyMs: null,
  selectedBackend: "not-applicable-legacy-polling",
  degraded: false,
};

const REFRESH_SCENARIOS = [
  {
    id: "tracked-write" as const,
    marker: "ordinary tracked write",
    mutate: ordinaryTrackedWrite,
  },
  {
    id: "atomic-rename" as const,
    marker: "atomic tracked write",
    mutate: atomicRenameTrackedWrite,
  },
  {
    id: "untracked-create" as const,
    marker: "relevant untracked mutation",
    mutate: relevantUntrackedCreation,
  },
];

/** Require the exact campaign runtime pinned by the frozen build protocol. */
export function assertCampaignBunVersion(version = Bun.version): void {
  if (version !== "1.3.14") {
    throw new Error(`Watch campaigns require exact Bun 1.3.14; found ${version}`);
  }
}

/** Prove the runner is the clean, separately frozen harness commit. */
function readHarnessSha(expectedHarnessSha: string): string {
  const harnessRoot = dirname(dirname(import.meta.dir));
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], {
    cwd: harnessRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (status.exitCode !== 0 || Buffer.from(status.stdout).toString("utf8").trim()) {
    throw new Error("Benchmark harness tracked state must be clean");
  }
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: harnessRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Unable to resolve benchmark harness SHA");
  const actual = Buffer.from(result.stdout).toString("utf8").trim().toLowerCase();
  if (actual !== expectedHarnessSha.toLowerCase()) {
    throw new Error(`Benchmark harness SHA mismatch: ${actual} != ${expectedHarnessSha}`);
  }
  return actual;
}

/** Reserve a loopback port briefly, then release it for one isolated daemon. */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve daemon port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

/** Start the exact revision's daemon and wait until its isolated health endpoint responds. */
async function startDaemon(options: {
  binary: VerifiedBinary;
  cwd: string;
  env: Record<string, string | undefined>;
  port: number;
}): Promise<Bun.Subprocess> {
  const process = Bun.spawn([options.binary.executablePath, "daemon", "serve"], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Prestarted Hunk daemon exited unexpectedly");
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/health`);
      if (response.ok && ((await response.json()) as { ok?: unknown }).ok === true) return process;
    } catch {
      // The daemon may not have bound its loopback socket yet.
    }
    await Bun.sleep(50);
  }
  process.kill();
  throw new Error("Timed out waiting for the prestarted Hunk daemon");
}

/** Stop one daemon and report whether the process handle was released. */
async function stopDaemon(process: Bun.Subprocess): Promise<boolean> {
  if (process.exitCode === null) process.kill();
  await Promise.race([process.exited, Bun.sleep(2_000)]);
  return process.exitCode !== null;
}

/** Build isolated user/config/cache/runtime directories inherited by daemon and TUI. */
function isolatedEnvironment(options: {
  outputDir: string;
  fixtureId: string;
  revision: BenchmarkRevision;
  port: number;
  extraEnv?: Record<string, string>;
}): Record<string, string | undefined> {
  const root = resolve(options.outputDir, "work", "env", options.fixtureId, options.revision);
  const home = join(root, "home");
  const config = join(root, "config");
  const cache = join(root, "cache");
  const data = join(root, "data");
  const runtime = join(root, "runtime");
  const appData = join(root, "appdata");
  const localAppData = join(root, "local-appdata");
  for (const path of [home, config, cache, data, runtime, appData, localAppData]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_RUNTIME_DIR: runtime,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    HUNK_DISABLE_UPDATE_NOTICE: "1",
    HUNK_MCP_PORT: String(options.port),
    TERM: "xterm-truecolor",
    NO_COLOR: undefined,
    ...options.extraEnv,
  };
}

/** Verify immutable fixture artifacts and repeat their manifest counts in raw records. */
function prepareFixture(config: CampaignConfig["fixtures"][number]): PreparedFixture {
  verifyFixtureArtifacts(config.artifactsDir);
  const manifestPath = join(config.artifactsDir, "fixture-manifest.json");
  if (fileSha256(manifestPath) !== config.manifestSha256) {
    throw new Error(`${config.id} fixture manifest SHA256 mismatch`);
  }
  const manifest = readFixtureManifest(config.artifactsDir);
  if (manifest.label !== config.label) throw new Error(`${config.id} fixture label mismatch`);
  return {
    config,
    manifest,
    record: {
      id: config.id,
      label: manifest.label,
      sourceSha: manifest.sourceSha,
      baselineCommit: manifest.baselineCommit,
      manifestSha256: config.manifestSha256,
      counts: manifest.counts,
    },
  };
}

/** Reconstruct or reset only through the declared fixture helpers, outside timed regions. */
function prepareFixtureState(fixture: PreparedFixture, reconstruct: boolean): void {
  if (reconstruct) {
    rmSync(fixture.config.repoDir, { recursive: true, force: true });
    reconstructFixture({
      artifactsDir: fixture.config.artifactsDir,
      repoDir: fixture.config.repoDir,
    });
  } else {
    resetFixtureState({
      artifactsDir: fixture.config.artifactsDir,
      repoDir: fixture.config.repoDir,
    });
  }
}

/** Execute one operation, preserving the failed attempt and allowing exactly one retry. */
export async function executeWithOneRetry<T>(
  operation: (retryAttempt: 0 | 1) => Promise<T>,
  onFailure: (error: unknown, retryAttempt: 0 | 1) => Promise<void> | void,
): Promise<T> {
  for (const retryAttempt of [0, 1] as const) {
    try {
      return await operation(retryAttempt);
    } catch (error) {
      await onFailure(error, retryAttempt);
      if (retryAttempt === 1) throw error;
    }
  }
  throw new Error("Unreachable retry state");
}

/** Translate thrown failures into stable raw diagnostics. */
function campaignError(error: unknown, phase: string): WatchRunRecord["errors"][number] {
  const value = error as { code?: unknown; message?: unknown };
  return {
    code: typeof value?.code === "string" ? value.code : "HUNK_BENCH_RUN_FAILED",
    phase,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Start a direct uninstrumented TUI after prestarting the same revision's daemon. */
async function startWatchSession(options: {
  binary: VerifiedBinary;
  fixture: PreparedFixture;
  outputDir: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
}): Promise<{
  session: WatchTerminalSession;
  daemon: Bun.Subprocess;
  launchToMarkerMs: number;
}> {
  const port = await reserveLoopbackPort();
  const env = isolatedEnvironment({
    outputDir: options.outputDir,
    fixtureId: options.fixture.config.id,
    revision: options.binary.revision,
    port,
    extraEnv: options.extraEnv,
  });
  const daemon = await startDaemon({
    binary: options.binary,
    cwd: options.fixture.config.repoDir,
    env,
    port,
  });
  try {
    const launched = await launchWatchTerminal({
      executablePath: options.binary.executablePath,
      cwd: options.fixture.config.repoDir,
      env,
      marker: {
        menu: "File  View",
        requiredText: options.fixture.config.requiredScreenText,
      },
      timeoutMs: options.timeoutMs,
    });
    return { session: launched.session, daemon, launchToMarkerMs: launched.launchToMarkerMs };
  } catch (error) {
    const daemonClean = await stopDaemon(daemon);
    const diagnostic = error as Error & { cleanupComplete?: boolean };
    diagnostic.cleanupComplete = diagnostic.cleanupComplete === true && daemonClean;
    throw diagnostic;
  }
}

/** Clean both TUI and daemon so no measured run overlaps the next one. */
async function cleanupRun(session: WatchTerminalSession, daemon: Bun.Subprocess): Promise<boolean> {
  const terminalClean = await session.cleanup();
  const daemonClean = await stopDaemon(daemon);
  return terminalClean && daemonClean;
}

/** Create a startup-only run after the fixture has already been prepared. */
async function measureStartup(options: {
  binary: VerifiedBinary;
  fixture: PreparedFixture;
  config: CampaignConfig;
}): Promise<RunMeasurements> {
  const launched = await startWatchSession({
    binary: options.binary,
    fixture: options.fixture,
    outputDir: options.config.outputDir,
    timeoutMs: options.config.startupTimeoutMs,
  });
  const startup = {
    launchToFirstMarkerMs: launched.launchToMarkerMs,
    markerVisible: true,
    screenTextSha256: launched.session.screenTextSha256(),
  };
  const terminalBytes = launched.session.screen.getRawBytes();
  const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
  if (!cleanupComplete)
    throw Object.assign(new Error("Startup cleanup leaked a process"), { terminalBytes });
  return { startup, idle: null, gitActivity: null, refresh: null, cleanupComplete, terminalBytes };
}

/** Measure cumulative main-process CPU and RSS only after the menu becomes visible. */
async function measureIdle(options: {
  binary: VerifiedBinary;
  fixture: PreparedFixture;
  config: CampaignConfig;
  durationMs: number;
  intervalMs: number;
}): Promise<RunMeasurements> {
  const launched = await startWatchSession({
    binary: options.binary,
    fixture: options.fixture,
    outputDir: options.config.outputDir,
    timeoutMs: options.config.startupTimeoutMs,
  });
  let samples: Awaited<ReturnType<typeof collectIdleSamples>>;
  try {
    samples = await collectIdleSamples({
      pid: launched.session.process.pid,
      durationMs: options.durationMs,
      intervalMs: options.intervalMs,
    });
  } catch (error) {
    const terminalBytes = launched.session.screen.getRawBytes();
    const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      terminalBytes,
      cleanupComplete,
    });
  }
  const terminalBytes = launched.session.screen.getRawBytes();
  const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
  const sampleErrors = samples.filter((sample) => sample.error || !sample.alive);
  if (sampleErrors.length)
    throw Object.assign(new Error("Idle process sampling failed or observed an exit"), {
      terminalBytes,
      cleanupComplete,
    });
  if (!cleanupComplete)
    throw Object.assign(new Error("Idle cleanup leaked a process"), { terminalBytes });
  const rssValues = samples.flatMap((sample) =>
    sample.rssBytes === null ? [] : [sample.rssBytes],
  );
  return {
    startup: null,
    idle: {
      durationMs: options.durationMs,
      sampleIntervalMs: options.intervalMs,
      samples,
      first60SecondSamples: samples.filter((sample) => sample.elapsedMs <= 60_000),
      first60SecondSample: samples.find((sample) => sample.elapsedMs === 60_000) ?? null,
      finalCpuTimeMs: samples.at(-1)?.cpuTimeMs ?? null,
      maximumRssBytes: rssValues.length ? Math.max(...rssValues) : null,
    },
    gitActivity: null,
    refresh: null,
    cleanupComplete,
    terminalBytes,
  };
}

/** Count Git activity in a separate Trace2 cohort, never in headline startup or CPU runs. */
async function measureGitActivity(options: {
  binary: VerifiedBinary;
  fixture: PreparedFixture;
  config: CampaignConfig;
  durationMs: number;
  rawPath: string;
}): Promise<RunMeasurements> {
  const trace = createGitTrace2Environment(`${options.rawPath}.trace2-raw.jsonl`);
  const launched = await startWatchSession({
    binary: options.binary,
    fixture: options.fixture,
    outputDir: options.config.outputDir,
    timeoutMs: options.config.startupTimeoutMs,
    extraEnv: trace.env,
  });
  // Trace2 is a separate steady-state cohort; startup commands are intentionally excluded.
  truncateSync(trace.rawTracePath, 0);
  await Bun.sleep(options.durationMs);
  const terminalBytes = launched.session.screen.getRawBytes();
  const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
  const gitActivity = finalizeGitTrace2Activity({
    rawTracePath: trace.rawTracePath,
    sanitizedLogPath: options.rawPath.replace(/\.json$/, ".git.jsonl"),
    durationMs: options.durationMs,
  });
  gitActivity.tracePath = relative(
    resolve(options.config.outputDir),
    gitActivity.tracePath,
  ).replaceAll("\\", "/");
  if (gitActivity.malformedLineCount > 0) {
    throw Object.assign(new Error("Git Trace2 activity log was malformed"), {
      terminalBytes,
      cleanupComplete,
    });
  }
  if (!cleanupComplete)
    throw Object.assign(new Error("Git activity cleanup leaked a process"), { terminalBytes });
  return { startup: null, idle: null, gitActivity, refresh: null, cleanupComplete, terminalBytes };
}

/** Measure mutation-to-visible latency while the declared helper keeps changed state in place. */
async function measureRefresh(options: {
  binary: VerifiedBinary;
  fixture: PreparedFixture;
  config: CampaignConfig;
  scenario: (typeof REFRESH_SCENARIOS)[number];
}): Promise<RunMeasurements> {
  const launched = await startWatchSession({
    binary: options.binary,
    fixture: options.fixture,
    outputDir: options.config.outputDir,
    timeoutMs: options.config.startupTimeoutMs,
  });
  // Menu paint can precede React effects; let the legacy 250 ms loop and candidate observer arm.
  await Bun.sleep(500);
  let latencyMs: number | null = null;
  const observe: MutationObserver = async ({ mutationStartedAtMs }) => {
    latencyMs = await launched.session.waitForVisibleText(
      options.scenario.marker,
      options.config.refreshTimeoutMs,
      mutationStartedAtMs,
    );
  };
  try {
    await options.scenario.mutate(
      {
        artifactsDir: options.fixture.config.artifactsDir,
        repoDir: options.fixture.config.repoDir,
        resetBeforeMutation: false,
      },
      observe,
    );
  } catch (error) {
    const terminalBytes = launched.session.screen.getRawBytes();
    const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      terminalBytes,
      cleanupComplete,
    });
  }
  const terminalBytes = launched.session.screen.getRawBytes();
  const cleanupComplete = await cleanupRun(launched.session, launched.daemon);
  if (latencyMs === null)
    throw Object.assign(new Error("Mutation callback did not record latency"), {
      terminalBytes,
      cleanupComplete,
    });
  if (!cleanupComplete)
    throw Object.assign(new Error("Refresh cleanup leaked a process"), { terminalBytes });
  return {
    startup: null,
    idle: null,
    gitActivity: null,
    refresh: {
      scenario: options.scenario.id,
      marker: options.scenario.marker,
      latencyMs,
      correct: true,
      timedOut: false,
    },
    cleanupComplete,
    terminalBytes,
  };
}

/** Keep failed records measured-but-empty instead of fabricating replacement metrics. */
function failedMeasurements(error: unknown): RunMeasurements {
  const cleanupComplete = (error as { cleanupComplete?: unknown })?.cleanupComplete;
  return {
    startup: null,
    idle: null,
    gitActivity: null,
    refresh: null,
    cleanupComplete: typeof cleanupComplete === "boolean" ? cleanupComplete : false,
  };
}

/** Materialize and validate one raw record around measured operation output. */
function makeRecord(options: {
  config: CampaignConfig;
  harnessSha: string;
  host: WatchRunRecord["host"];
  binary: VerifiedBinary;
  descriptor: RunDescriptor;
  retryAttempt: 0 | 1;
  runNumber: number;
  startedAt: string;
  finishedAt: string;
  observer: ObserverMetrics;
  rawPath: string;
  measurements: RunMeasurements;
  valid: boolean;
  errors: WatchRunRecord["errors"];
}): WatchRunRecord {
  return watchRunRecordSchema.parse({
    schemaVersion: 1,
    protocolVersion: WATCH_PROTOCOL_VERSION,
    measurement: "measured",
    executionMode: options.config.preflightOnly ? "preflight" : "final",
    campaignId: options.config.campaignId,
    orderSeed: options.config.orderSeed,
    harnessSha: options.harnessSha,
    campaignShas: {
      base: options.config.binaries.base.expectedSourceSha,
      candidate: options.config.binaries.candidate.expectedSourceSha,
      harness: options.harnessSha,
    },
    host: options.host,
    binary: options.binary,
    fixture: options.descriptor.fixture.record,
    runId: `${options.descriptor.fixture.config.id}-${options.binary.revision}-${options.descriptor.runKind}-${String(options.runNumber).padStart(2, "0")}-attempt-${options.retryAttempt + 1}`,
    runKind: options.descriptor.runKind,
    trial: options.descriptor.trial,
    orderIndex: options.descriptor.orderIndex,
    startupLaunchIndex: options.descriptor.startupLaunchIndex,
    cacheLabel: options.descriptor.cacheLabel,
    warmup: options.descriptor.warmup,
    retryAttempt: options.retryAttempt,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    terminal: {
      columns: WATCH_TERMINAL_GEOMETRY.columns,
      rows: WATCH_TERMINAL_GEOMETRY.rows,
      menuMarker: "File  View",
      requiredScreenText: options.descriptor.fixture.config.requiredScreenText,
      parser: terminalScreenParser(),
      rawLogPath: relative(
        resolve(options.config.outputDir),
        terminalLogPath(options.rawPath),
      ).replaceAll("\\", "/"),
    },
    startup: options.measurements.startup,
    observer: options.measurements.observer ?? options.observer,
    idle: options.measurements.idle,
    gitActivity: options.measurements.gitActivity,
    refresh: options.measurements.refresh,
    valid: options.valid,
    errors: options.errors,
    cleanupComplete: options.measurements.cleanupComplete,
  });
}

/** Run and persist one descriptor with checksum re-verification and one cleanup/reset retry. */
async function runDescriptor(options: {
  config: CampaignConfig;
  harnessSha: string;
  host: WatchRunRecord["host"];
  binaries: Record<BenchmarkRevision, VerifiedBinary>;
  descriptor: RunDescriptor;
  runNumber: number;
  observer: ObserverMetrics;
  prepare: (retryAttempt: 0 | 1) => void;
  measure: (rawPath: string) => Promise<RunMeasurements>;
  records: WatchRunRecord[];
}): Promise<WatchRunRecord> {
  const binaryConfig = options.config.binaries[options.descriptor.revision];
  const attemptStartedAt = new Map<0 | 1, string>();
  return executeWithOneRetry(
    async (retryAttempt) => {
      const startedAt = new Date().toISOString();
      attemptStartedAt.set(retryAttempt, startedAt);
      verifyBinaryProvenance(
        options.descriptor.revision,
        binaryConfig.executablePath,
        binaryConfig.provenancePath,
        binaryConfig.expectedSourceSha,
      );
      options.prepare(retryAttempt);
      const rawPath = rawResultPath({
        outputDir: options.config.outputDir,
        hostId: options.host.hostId,
        fixtureId: options.descriptor.fixture.config.id,
        revision: options.descriptor.revision,
        runKind: options.descriptor.runKind,
        runNumber: options.runNumber,
        retryAttempt,
      });
      const measurements = await options.measure(rawPath);
      const record = makeRecord({
        config: options.config,
        harnessSha: options.harnessSha,
        host: options.host,
        binary: options.binaries[options.descriptor.revision],
        descriptor: options.descriptor,
        retryAttempt,
        runNumber: options.runNumber,
        startedAt,
        finishedAt: new Date().toISOString(),
        observer: options.observer,
        rawPath,
        measurements,
        valid: true,
        errors: measurements.errors ?? [],
      });
      writeRawRecord(rawPath, record);
      writeFileSync(terminalLogPath(rawPath), measurements.terminalBytes ?? new Uint8Array());
      options.records.push(record);
      return record;
    },
    async (error, retryAttempt) => {
      const rawPath = rawResultPath({
        outputDir: options.config.outputDir,
        hostId: options.host.hostId,
        fixtureId: options.descriptor.fixture.config.id,
        revision: options.descriptor.revision,
        runKind: options.descriptor.runKind,
        runNumber: options.runNumber,
        retryAttempt,
      });
      const terminalBytes = (error as { terminalBytes?: Uint8Array }).terminalBytes;
      const now = new Date().toISOString();
      const failed = makeRecord({
        config: options.config,
        harnessSha: options.harnessSha,
        host: options.host,
        binary: options.binaries[options.descriptor.revision],
        descriptor: options.descriptor,
        retryAttempt,
        runNumber: options.runNumber,
        startedAt: attemptStartedAt.get(retryAttempt) ?? now,
        finishedAt: now,
        observer: options.observer,
        rawPath,
        measurements: failedMeasurements(error),
        valid: false,
        errors: [campaignError(error, options.descriptor.runKind)],
      });
      writeRawRecord(rawPath, failed);
      writeFileSync(terminalLogPath(rawPath), terminalBytes ?? new Uint8Array());
      if (options.descriptor.runKind === "git-activity") {
        const tracePath = `${rawPath}.trace2-raw.jsonl`;
        if (existsSync(tracePath)) {
          try {
            finalizeGitTrace2Activity({
              rawTracePath: tracePath,
              sanitizedLogPath: rawPath.replace(/\.json$/, ".git.jsonl"),
              durationMs: options.config.idleDurationMs,
            });
          } catch {
            rmSync(tracePath, { force: true });
          }
        }
      }
      options.records.push(failed);
      try {
        prepareFixtureState(options.descriptor.fixture, false);
      } catch {
        // The retry path will reconstruct when its descriptor policy requires it.
      }
    },
  );
}

/** Run a source-imported candidate observer probe and emit base N/A with the same schema. */
async function measureObserverForFixture(options: {
  config: CampaignConfig;
  fixture: PreparedFixture;
  binaries: Record<BenchmarkRevision, VerifiedBinary>;
  harnessSha: string;
  host: WatchRunRecord["host"];
  records: WatchRunRecord[];
  nextRunNumber: (revision: BenchmarkRevision, kind: WatchRunKind) => number;
  nextOrderIndex: () => number;
}): Promise<Record<BenchmarkRevision, ObserverMetrics>> {
  const observers: Record<BenchmarkRevision, ObserverMetrics> = {
    base: LEGACY_OBSERVER,
    candidate: {
      ...LEGACY_OBSERVER,
      observerReadyStatus: "not-measured",
      selectedBackend: process.platform === "linux" ? "chokidar-portable" : "native-recursive",
      degraded: false,
    },
  };

  for (const revision of ["base", "candidate"] as const) {
    const descriptor: RunDescriptor = {
      fixture: options.fixture,
      revision,
      runKind: "observer-probe",
      trial: 1,
      orderIndex: options.nextOrderIndex(),
      startupLaunchIndex: null,
      cacheLabel: "warm",
      warmup: false,
    };
    const runNumber = options.nextRunNumber(revision, "observer-probe");
    const record = await runDescriptor({
      ...options,
      descriptor,
      runNumber,
      observer: revision === "base" ? LEGACY_OBSERVER : observers.candidate,
      prepare: () => prepareFixtureState(options.fixture, false),
      measure: async () => {
        if (revision === "base") {
          return {
            startup: null,
            idle: null,
            gitActivity: null,
            refresh: null,
            cleanupComplete: true,
            observer: LEGACY_OBSERVER,
          };
        }
        const result = await launchObserverProbe({
          repoDir: options.fixture.config.repoDir,
          timeoutMs: options.config.startupTimeoutMs,
        });
        const expectedBackend =
          process.platform === "linux" ? "chokidar-portable" : "native-recursive";
        if (result.status !== "ready")
          throw new Error(`Observer probe did not become ready: ${result.status}`);
        if (result.selectedBackend !== expectedBackend) {
          throw new Error(
            `Observer backend mismatch: ${result.selectedBackend}, expected ${expectedBackend}`,
          );
        }
        const observer: ObserverMetrics = {
          metricLabel: "probe process launch -> observer ready",
          observerReadyStatus: "ready",
          observerReadyMs: result.processLaunchToReadyMs,
          planDerivationMs: result.planDerivationMs,
          constructionToReadyMs: result.constructionToReadyMs,
          selectedBackend: result.selectedBackend,
          degraded: result.degraded,
        };
        if (observer.degraded) throw new Error("Observer probe entered degraded mode");
        return {
          startup: null,
          idle: null,
          gitActivity: null,
          refresh: null,
          cleanupComplete: true,
          observer,
        };
      },
      records: options.records,
    });
    observers[revision] = record.observer;
  }
  return observers;
}

/** Execute the deterministic campaign or its bounded, explicitly non-final preflight variant. */
export async function runCampaign(
  config: CampaignConfig,
  preflight = false,
): Promise<WatchRunRecord[]> {
  assertCampaignBunVersion();
  if (!preflight) {
    if (config.preflightOnly) {
      throw new Error("A preflight-only campaign cannot execute final measurement cells");
    }
    if (config.idleDurationMs !== 120_000 || config.idleSampleIntervalMs !== 10_000) {
      throw new Error("Final campaign idle policy must be 120 seconds sampled every 10 seconds");
    }
    if (config.refreshTrials !== 5) throw new Error("Final campaign requires five refresh trials");
  }
  // Mark every record from the bounded CLI mode as preflight, including frozen-input dry runs.
  config = { ...config, preflightOnly: preflight || config.preflightOnly };
  const harnessSha = readHarnessSha(config.expectedHarnessSha);
  assertWatchHostIdentity(config.hostId);
  const host = collectHostMetadata(config.hostId);
  const binaries = {
    base: verifyBinaryProvenance(
      "base",
      config.binaries.base.executablePath,
      config.binaries.base.provenancePath,
      config.binaries.base.expectedSourceSha,
    ),
    candidate: verifyBinaryProvenance(
      "candidate",
      config.binaries.candidate.executablePath,
      config.binaries.candidate.provenancePath,
      config.binaries.candidate.expectedSourceSha,
    ),
  };
  const fixtures = config.fixtures.map(prepareFixture);
  const selectedFixtures = preflight ? fixtures.slice(0, 1) : fixtures;
  const records: WatchRunRecord[] = [];
  const runCounts = new Map<string, number>();
  let orderIndex = 0;
  const nextOrderIndex = () => orderIndex++;
  const nextRunNumber = (revision: BenchmarkRevision, kind: WatchRunKind) => {
    const key = `${revision}:${kind}`;
    const next = (runCounts.get(key) ?? 0) + 1;
    runCounts.set(key, next);
    return next;
  };
  const preflightDurationMs = Math.min(config.idleDurationMs, 20_000);
  const preflightIntervalMs = Math.min(config.idleSampleIntervalMs, 10_000);
  const idleDurationMs = preflight ? preflightDurationMs : config.idleDurationMs;
  const idleIntervalMs = preflight ? preflightIntervalMs : config.idleSampleIntervalMs;
  const refreshTrials = preflight ? 1 : config.refreshTrials;

  for (const fixture of selectedFixtures) {
    runCounts.clear();
    // Cold-ish observations reconstruct the same checkout separately for each revision.
    for (const revision of ["base", "candidate"] as const) {
      const descriptor: RunDescriptor = {
        fixture,
        revision,
        runKind: "cold-startup",
        trial: 1,
        orderIndex: nextOrderIndex(),
        startupLaunchIndex: null,
        cacheLabel: "cold-ish",
        warmup: false,
      };
      await runDescriptor({
        config,
        harnessSha,
        host,
        binaries,
        descriptor,
        runNumber: nextRunNumber(revision, descriptor.runKind),
        observer:
          revision === "base"
            ? LEGACY_OBSERVER
            : {
                ...LEGACY_OBSERVER,
                observerReadyStatus: "not-measured",
                selectedBackend:
                  process.platform === "linux" ? "chokidar-portable" : "native-recursive",
              },
        prepare: () => prepareFixtureState(fixture, true),
        measure: () => measureStartup({ binary: binaries[revision], fixture, config }),
        records,
      });
    }

    const observers = await measureObserverForFixture({
      config,
      fixture,
      binaries,
      harnessSha,
      host,
      records,
      nextRunNumber,
      nextOrderIndex,
    });

    // One explicit unmeasured warmup per revision remains recorded and excluded from summaries.
    for (const revision of ["base", "candidate"] as const) {
      const descriptor: RunDescriptor = {
        fixture,
        revision,
        runKind: "warmup",
        trial: 1,
        orderIndex: nextOrderIndex(),
        startupLaunchIndex: null,
        cacheLabel: "warm",
        warmup: true,
      };
      await runDescriptor({
        config,
        harnessSha,
        host,
        binaries,
        descriptor,
        runNumber: nextRunNumber(revision, descriptor.runKind),
        observer: observers[revision],
        prepare: () => prepareFixtureState(fixture, false),
        measure: () => measureStartup({ binary: binaries[revision], fixture, config }),
        records,
      });
    }

    const startupOrder = preflight
      ? (["base", "candidate"] as const)
      : startupLaunchOrder(config.orderSeed);
    const startupTrials: Record<BenchmarkRevision, number> = { base: 0, candidate: 0 };
    for (const [launchIndex, revision] of startupOrder.entries()) {
      startupTrials[revision] += 1;
      const descriptor: RunDescriptor = {
        fixture,
        revision,
        runKind: "startup",
        trial: startupTrials[revision],
        orderIndex: nextOrderIndex(),
        startupLaunchIndex: launchIndex + 1,
        cacheLabel: "warm",
        warmup: false,
      };
      await runDescriptor({
        config,
        harnessSha,
        host,
        binaries,
        descriptor,
        runNumber: nextRunNumber(revision, descriptor.runKind),
        observer: observers[revision],
        prepare: () => prepareFixtureState(fixture, false),
        measure: () => measureStartup({ binary: binaries[revision], fixture, config }),
        records,
      });
    }

    const idleOrders = preflight
      ? [["base", "candidate"] as const]
      : [["base", "candidate"] as const, ["candidate", "base"] as const];
    const idleTrials: Record<BenchmarkRevision, number> = { base: 0, candidate: 0 };
    for (const runOrder of idleOrders) {
      for (const revision of runOrder) {
        idleTrials[revision] += 1;
        const descriptor: RunDescriptor = {
          fixture,
          revision,
          runKind: "idle",
          trial: idleTrials[revision],
          orderIndex: nextOrderIndex(),
          startupLaunchIndex: null,
          cacheLabel: "warm",
          warmup: false,
        };
        await runDescriptor({
          config,
          harnessSha,
          host,
          binaries,
          descriptor,
          runNumber: nextRunNumber(revision, descriptor.runKind),
          observer: observers[revision],
          prepare: () => prepareFixtureState(fixture, false),
          measure: () =>
            measureIdle({
              binary: binaries[revision],
              fixture,
              config,
              durationMs: idleDurationMs,
              intervalMs: idleIntervalMs,
            }),
          records,
        });
      }
    }

    for (const revision of ["base", "candidate"] as const) {
      const descriptor: RunDescriptor = {
        fixture,
        revision,
        runKind: "git-activity",
        trial: 1,
        orderIndex: nextOrderIndex(),
        startupLaunchIndex: null,
        cacheLabel: "warm",
        warmup: false,
      };
      await runDescriptor({
        config,
        harnessSha,
        host,
        binaries,
        descriptor,
        runNumber: nextRunNumber(revision, descriptor.runKind),
        observer: observers[revision],
        prepare: () => prepareFixtureState(fixture, false),
        measure: (rawPath) =>
          measureGitActivity({
            binary: binaries[revision],
            fixture,
            config,
            durationMs: idleDurationMs,
            rawPath,
          }),
        records,
      });
    }

    const refreshScenarios = preflight ? REFRESH_SCENARIOS.slice(0, 1) : REFRESH_SCENARIOS;
    for (const scenario of refreshScenarios) {
      for (const revision of ["base", "candidate"] as const) {
        for (let trial = 1; trial <= refreshTrials; trial += 1) {
          const descriptor: RunDescriptor = {
            fixture,
            revision,
            runKind: "refresh",
            trial,
            orderIndex: nextOrderIndex(),
            startupLaunchIndex: null,
            cacheLabel: "warm",
            warmup: false,
          };
          await runDescriptor({
            config,
            harnessSha,
            host,
            binaries,
            descriptor,
            runNumber: nextRunNumber(revision, descriptor.runKind),
            observer: observers[revision],
            prepare: () => prepareFixtureState(fixture, false),
            measure: () =>
              measureRefresh({ binary: binaries[revision], fixture, config, scenario }),
            records,
          });
        }
      }
    }
  }

  const reportPath = join(config.outputDir, "summaries", `${host.hostId}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderWatchMarkdown(records));
  return records;
}

/** Parse the committed campaign command without embedding final campaign SHAs. */
async function main(args: string[]): Promise<void> {
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath) throw new Error("Usage: run.ts --config <campaign.json> [--preflight]");
  const config = readCampaignConfig(configPath);
  const records = await runCampaign(config, args.includes("--preflight"));
  process.stdout.write(
    `${records.length} measured records written to ${resolve(config.outputDir)}\n`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
