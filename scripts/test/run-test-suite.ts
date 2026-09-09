#!/usr/bin/env bun

/**
 * Runs Hunk's test groups concurrently without Bun's isolated parallel worker mode.
 *
 * Bun 1.3.14's `--parallel` implies `--isolate`, which makes OpenTUI's native FFI
 * renderer fail to initialize with "Cannot access 'default' before initialization."
 * Independent `--shard=N/M` processes avoid that failure, but Bun runs only the one
 * requested shard, so this module launches and supervises every shard. The default suite
 * shards automatically on Linux; resource-intensive PTY tests and non-Linux platforms
 * stay serial unless CI or a developer explicitly chooses a validated shard count.
 */

import { availableParallelism } from "node:os";

export const TEST_PATTERN_GROUPS = {
  default: ["./packages", "./scripts", "./examples", "./test/cli", "./test/session"],
  integration: ["./test/pty"],
} as const;

export const DEFAULT_TEST_PATTERNS = TEST_PATTERN_GROUPS.default;
export type TestPatternGroup = keyof typeof TEST_PATTERN_GROUPS;

const MAX_AUTOMATIC_TEST_SHARDS = 2;
const MAX_EXPLICIT_TEST_SHARDS = 64;
const SHARD_TERMINATION_GRACE_MS = 1_000;

type KillableProcess = {
  kill(signal?: number | NodeJS.Signals): void;
};

/** Resolve an explicit shard override or choose a bounded Linux count from available CPUs. */
export function resolveTestShardCount(
  cpuCount: number,
  override?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (override !== undefined) {
    const count = Number(override);
    if (!/^\d+$/.test(override) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error("HUNK_TEST_SHARDS must be a positive safe integer");
    }
    if (count > MAX_EXPLICIT_TEST_SHARDS) {
      throw new Error(`HUNK_TEST_SHARDS cannot exceed ${MAX_EXPLICIT_TEST_SHARDS}`);
    }
    return count;
  }

  if (platform !== "linux") return 1;
  return Math.min(MAX_AUTOMATIC_TEST_SHARDS, Math.max(1, Math.floor(cpuCount)));
}

/** Keep resource-intensive PTY tests serial unless the caller explicitly chooses a shard count. */
export function resolveTestGroupShardCount(
  cpuCount: number,
  override: string | undefined,
  platform: NodeJS.Platform,
  group: TestPatternGroup,
) {
  if (group === "integration" && override === undefined) return 1;
  return resolveTestShardCount(cpuCount, override, platform);
}

/** Resolve the selected test group while preserving arguments meant for Bun's test runner. */
export function resolveTestInvocation(args: string[]) {
  const groupArguments = args.filter((arg) => arg.startsWith("--group="));
  if (groupArguments.length > 1) {
    throw new Error("Only one --group argument may be provided");
  }

  const group = (groupArguments[0]?.slice("--group=".length) ?? "default") as TestPatternGroup;
  if (!Object.hasOwn(TEST_PATTERN_GROUPS, group)) {
    throw new Error(`Unknown test group: ${group}`);
  }

  return {
    forwardedArgs: args.filter((arg) => !arg.startsWith("--group=")),
    group,
    patterns: TEST_PATTERN_GROUPS[group],
  };
}

/** Keep filtered runs and shared file-backed output on one process. */
export function requiresSerialTestExecution(args: string[]) {
  return args.some(
    (arg) =>
      arg === "-t" ||
      arg === "--only" ||
      arg.startsWith("--test-name-pattern") ||
      arg.startsWith("--coverage") ||
      arg.startsWith("--reporter-outfile"),
  );
}

/** Build one Bun test command for an independent file shard. */
export function buildTestShardCommand(
  bunExecutable: string,
  shard: number,
  shardCount: number,
  forwardedArgs: string[] = [],
  platform: NodeJS.Platform = process.platform,
  patterns: readonly string[] = DEFAULT_TEST_PATTERNS,
) {
  return [
    bunExecutable,
    "test",
    ...(platform === "win32" ? [] : ["--no-orphans"]),
    ...(shardCount > 1 ? [`--shard=${shard}/${shardCount}`] : []),
    ...patterns,
    ...forwardedArgs,
  ];
}

/** Forward a termination signal to every live shard, tolerating shards that already exited. */
export function terminateTestShardProcesses(processes: KillableProcess[], signal: NodeJS.Signals) {
  for (const proc of processes) {
    try {
      proc.kill(signal);
    } catch {
      // Another shard or the terminal process group may already have stopped it.
    }
  }
}

/** Run one test group in independent Bun processes without enabling Bun's isolate mode. */
export async function main(args = Bun.argv.slice(2)) {
  const { forwardedArgs, group, patterns } = resolveTestInvocation(args);
  const resolvedShardCount = resolveTestGroupShardCount(
    availableParallelism(),
    process.env.HUNK_TEST_SHARDS,
    process.platform,
    group,
  );
  const shardCount = requiresSerialTestExecution(forwardedArgs) ? 1 : resolvedShardCount;
  const bunExecutable = process.execPath;

  console.error(
    `Running the ${group} test group in ${shardCount} shard${shardCount === 1 ? "" : "s"}...`,
  );

  const shards: Array<{ proc: ReturnType<typeof Bun.spawn>; shard: number }> = [];
  try {
    for (let index = 0; index < shardCount; index += 1) {
      const shard = index + 1;
      const proc = Bun.spawn(
        buildTestShardCommand(
          bunExecutable,
          shard,
          shardCount,
          forwardedArgs,
          process.platform,
          patterns,
        ),
        {
          cwd: process.cwd(),
          env: { ...process.env, npm_execpath: bunExecutable },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      shards.push({ proc, shard });
    }
  } catch (error) {
    const spawnedProcesses = shards.map(({ proc }) => proc);
    terminateTestShardProcesses(spawnedProcesses, "SIGTERM");
    const forceKillTimer = setTimeout(() => {
      terminateTestShardProcesses(spawnedProcesses, "SIGKILL");
    }, SHARD_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
    try {
      await Promise.allSettled(shards.map(({ proc }) => proc.exited));
    } finally {
      clearTimeout(forceKillTimer);
    }
    throw error;
  }

  const processes = shards.map(({ proc }) => proc);
  let interruptedExitCode: number | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const handleSignal = (signal: NodeJS.Signals, exitCode: number) => {
    if (interruptedExitCode !== null) return;
    interruptedExitCode = exitCode;
    terminateTestShardProcesses(processes, signal);
    forceKillTimer = setTimeout(() => {
      terminateTestShardProcesses(processes, "SIGKILL");
    }, SHARD_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };
  const handleSigint = () => handleSignal("SIGINT", 130);
  const handleSigterm = () => handleSignal("SIGTERM", 143);
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  let results: Array<{ exitCode: number; shard: number }>;
  try {
    results = await Promise.all(
      shards.map(async ({ proc, shard }) => ({ exitCode: await proc.exited, shard })),
    );
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }

  if (interruptedExitCode !== null) return interruptedExitCode;
  const failedShards = results.filter(({ exitCode }) => exitCode !== 0);

  if (failedShards.length > 0) {
    console.error(
      `Test shard failure: ${failedShards
        .map(({ exitCode, shard }) => `${shard}/${shardCount} (exit ${exitCode})`)
        .join(", ")}`,
    );
    return 1;
  }

  console.error(`All ${shardCount} test shard${shardCount === 1 ? "" : "s"} passed.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
