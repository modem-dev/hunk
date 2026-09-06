#!/usr/bin/env bun

/**
 * Runs Hunk's default tests concurrently without Bun's isolated parallel worker mode.
 *
 * Bun 1.3.14's `--parallel` implies `--isolate`, which makes OpenTUI's native FFI
 * renderer fail to initialize with "Cannot access 'default' before initialization."
 * Independent `--shard=N/M` processes avoid that failure, but Bun runs only the one
 * requested shard, so this module launches and supervises every shard. Sharding stays
 * Linux-only because the complete multi-process suite is validated and benchmarked there.
 */

import { availableParallelism } from "node:os";

export const DEFAULT_TEST_PATTERNS = [
  "./packages",
  "./scripts",
  "./examples",
  "./test/cli",
  "./test/session",
] as const;

const MAX_AUTOMATIC_TEST_SHARDS = 2;
const MAX_EXPLICIT_TEST_SHARDS = 64;
const SHARD_TERMINATION_GRACE_MS = 1_000;

type KillableProcess = {
  kill(signal?: number | NodeJS.Signals): void;
};

/** Resolve a Linux shard override or choose a bounded count from the available CPUs. */
export function resolveTestShardCount(
  cpuCount: number,
  override?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "linux") return 1;

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

  return Math.min(MAX_AUTOMATIC_TEST_SHARDS, Math.max(1, Math.floor(cpuCount)));
}

/** Build one Bun test command for an independent file shard. */
export function buildTestShardCommand(
  bunExecutable: string,
  shard: number,
  shardCount: number,
  forwardedArgs: string[] = [],
  platform: NodeJS.Platform = process.platform,
) {
  return [
    bunExecutable,
    "test",
    ...(platform === "win32" ? [] : ["--no-orphans"]),
    ...(shardCount > 1 ? [`--shard=${shard}/${shardCount}`] : []),
    ...DEFAULT_TEST_PATTERNS,
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

/** Run the default suite in independent Bun processes without enabling Bun's isolate mode. */
export async function main(args = Bun.argv.slice(2)) {
  const shardCount = resolveTestShardCount(availableParallelism(), process.env.HUNK_TEST_SHARDS);
  const bunExecutable = process.execPath;

  console.error(`Running the test suite in ${shardCount} shard${shardCount === 1 ? "" : "s"}...`);

  const shards: Array<{ proc: ReturnType<typeof Bun.spawn>; shard: number }> = [];
  try {
    for (let index = 0; index < shardCount; index += 1) {
      const shard = index + 1;
      const proc = Bun.spawn(
        buildTestShardCommand(bunExecutable, shard, shardCount, args, process.platform),
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
