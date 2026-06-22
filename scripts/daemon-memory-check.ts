#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { HUNK_SESSION_API_PATH } from "../src/session/protocol";

type MemorySample = {
  label: string;
  cycle: number;
  rssBytes: number;
  heapBytes: number | null;
  highWaterRssBytes: number | null;
  sessions: number | null;
  pendingCommands: number | null;
};

type HealthResponse = {
  ok: boolean;
  pid: number;
  sessions: number;
  pendingCommands: number;
};

type CliOptions = {
  cycles: number;
  warmupCycles: number;
  sessionsPerCycle: number;
  filesPerSession: number;
  hunksPerFile: number;
  linesPerHunk: number;
  apiRequestsPerCycle: number;
  snapshotUpdatesPerCycle: number;
  settleMs: number;
  maxRssGrowthMb: number;
  maxRssSlopeKb: number;
  jsonOut?: string;
};

const defaultOptions: CliOptions = {
  cycles: 50,
  warmupCycles: 5,
  sessionsPerCycle: 2,
  filesPerSession: 30,
  hunksPerFile: 4,
  linesPerHunk: 18,
  apiRequestsPerCycle: 4,
  snapshotUpdatesPerCycle: 3,
  settleMs: 50,
  maxRssGrowthMb: 96,
  maxRssSlopeKb: 768,
};

function parseNumberOption(name: string, value: string | undefined) {
  if (value === undefined) {
    throw new Error(`Missing value for ${name}.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected ${name} to be a non-negative number.`);
  }

  return parsed;
}

/** Parse a small flag set without adding a runtime dependency to the memory harness. */
function parseArgs(argv: string[]): CliOptions {
  const options = { ...defaultOptions };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: bun run scripts/daemon-memory-check.ts [options]\n\nOptions:\n  --cycles <n>                  Register/use/unregister cycles (default ${defaultOptions.cycles})\n  --warmup-cycles <n>           Cycles ignored for trend analysis (default ${defaultOptions.warmupCycles})\n  --sessions-per-cycle <n>      Fake websocket sessions per cycle (default ${defaultOptions.sessionsPerCycle})\n  --files-per-session <n>       Review files stored per fake session (default ${defaultOptions.filesPerSession})\n  --hunks-per-file <n>          Hunks per review file (default ${defaultOptions.hunksPerFile})\n  --lines-per-hunk <n>          Diff lines per hunk side (default ${defaultOptions.linesPerHunk})\n  --api-requests-per-cycle <n>  list/context/review requests while sessions are live (default ${defaultOptions.apiRequestsPerCycle})\n  --snapshot-updates-per-cycle <n>  Snapshot update messages per session per cycle (default ${defaultOptions.snapshotUpdatesPerCycle})\n  --settle-ms <n>               Delay before post-cleanup sampling (default ${defaultOptions.settleMs})\n  --max-rss-growth-mb <n>       Fail if post-warmup RSS grows beyond this (default ${defaultOptions.maxRssGrowthMb})\n  --max-rss-slope-kb <n>        Fail if post-warmup RSS slope exceeds this per cycle (default ${defaultOptions.maxRssSlopeKb})\n  --json-out <path>             Write full sample summary JSON\n`,
      );
      process.exit(0);
    }

    const next = () => argv[++index];
    switch (arg) {
      case "--cycles":
        options.cycles = parseNumberOption(arg, next());
        break;
      case "--warmup-cycles":
        options.warmupCycles = parseNumberOption(arg, next());
        break;
      case "--sessions-per-cycle":
        options.sessionsPerCycle = parseNumberOption(arg, next());
        break;
      case "--files-per-session":
        options.filesPerSession = parseNumberOption(arg, next());
        break;
      case "--hunks-per-file":
        options.hunksPerFile = parseNumberOption(arg, next());
        break;
      case "--lines-per-hunk":
        options.linesPerHunk = parseNumberOption(arg, next());
        break;
      case "--api-requests-per-cycle":
        options.apiRequestsPerCycle = parseNumberOption(arg, next());
        break;
      case "--snapshot-updates-per-cycle":
        options.snapshotUpdatesPerCycle = parseNumberOption(arg, next());
        break;
      case "--settle-ms":
        options.settleMs = parseNumberOption(arg, next());
        break;
      case "--max-rss-growth-mb":
        options.maxRssGrowthMb = parseNumberOption(arg, next());
        break;
      case "--max-rss-slope-kb":
        options.maxRssSlopeKb = parseNumberOption(arg, next());
        break;
      case "--json-out":
        options.jsonOut = next();
        if (!options.jsonOut) {
          throw new Error("Missing value for --json-out.");
        }
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.cycles = Math.trunc(options.cycles);
  options.warmupCycles = Math.trunc(
    Math.min(options.warmupCycles, Math.max(0, options.cycles - 1)),
  );
  options.sessionsPerCycle = Math.trunc(options.sessionsPerCycle);
  options.filesPerSession = Math.trunc(options.filesPerSession);
  options.hunksPerFile = Math.trunc(options.hunksPerFile);
  options.linesPerHunk = Math.trunc(options.linesPerHunk);
  options.apiRequestsPerCycle = Math.trunc(options.apiRequestsPerCycle);
  options.snapshotUpdatesPerCycle = Math.trunc(options.snapshotUpdatesPerCycle);
  return options;
}

async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function waitUntil<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }

  throw new Error(
    `Timed out waiting for ${label}.${lastError ? ` Last error: ${String(lastError)}` : ""}`,
  );
}

async function readHealth(port: number): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

function parseLinuxStatus(pid: number) {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const valueKb = (name: string) => {
      const match = status.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };
    return {
      rssBytes: valueKb("VmRSS") ?? 0,
      // External process probes cannot reliably read Bun's JS heap; RSS is the leak signal here.
      heapBytes: null,
      highWaterRssBytes: valueKb("VmHWM"),
    };
  } catch {
    return null;
  }
}

async function readProcessMemory(pid: number) {
  const linux = parseLinuxStatus(pid);
  if (linux) {
    return linux;
  }

  const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const rssKb = Number(result.stdout.toString().trim());
  return {
    rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
    heapBytes: null,
    highWaterRssBytes: null,
  };
}

function formatBytes(bytes: number | null) {
  if (bytes === null) {
    return "n/a";
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function makePatch(fileIndex: number, hunksPerFile: number, linesPerHunk: number) {
  const chunks: string[] = [];
  for (let hunkIndex = 0; hunkIndex < hunksPerFile; hunkIndex += 1) {
    const start = hunkIndex * (linesPerHunk + 3) + 1;
    chunks.push(`@@ -${start},${linesPerHunk} +${start},${linesPerHunk} @@`);
    for (let lineIndex = 0; lineIndex < linesPerHunk; lineIndex += 1) {
      chunks.push(`-old_${fileIndex}_${hunkIndex}_${lineIndex} = ${lineIndex};`);
      chunks.push(`+new_${fileIndex}_${hunkIndex}_${lineIndex} = ${lineIndex + 1};`);
      chunks.push(` context_${fileIndex}_${hunkIndex}_${lineIndex}();`);
    }
  }
  return chunks.join("\n");
}

function makeReviewFile(sessionId: string, fileIndex: number, options: CliOptions) {
  const path = `src/${sessionId}/file-${fileIndex}.ts`;
  const hunks = Array.from({ length: options.hunksPerFile }, (_, hunkIndex) => {
    const start = hunkIndex * (options.linesPerHunk + 3) + 1;
    return {
      index: hunkIndex,
      header: `@@ -${start},${options.linesPerHunk} +${start},${options.linesPerHunk} @@`,
      oldRange: [start, options.linesPerHunk],
      newRange: [start, options.linesPerHunk],
    };
  });

  return {
    id: `${sessionId}-file-${fileIndex}`,
    path,
    additions: options.hunksPerFile * options.linesPerHunk,
    deletions: options.hunksPerFile * options.linesPerHunk,
    hunkCount: options.hunksPerFile,
    patch: makePatch(fileIndex, options.hunksPerFile, options.linesPerHunk),
    hunks,
  };
}

function makeRegistration(
  sessionId: string,
  cycle: number,
  sessionIndex: number,
  options: CliOptions,
) {
  const cwd = `/tmp/hunk-daemon-memory/${cycle}/${sessionIndex}`;
  const files = Array.from({ length: options.filesPerSession }, (_, fileIndex) =>
    makeReviewFile(sessionId, fileIndex, options),
  );

  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId,
    pid: process.pid,
    cwd,
    repoRoot: cwd,
    launchedAt: new Date().toISOString(),
    info: {
      inputKind: "vcs",
      title: `memory test ${sessionId}`,
      sourceLabel: cwd,
      files,
    },
  };
}

function makeSnapshot(sessionId: string, updateIndex = 0, options: CliOptions = defaultOptions) {
  const fileIndex = updateIndex % Math.max(1, options.filesPerSession);
  const hunkIndex = updateIndex % Math.max(1, options.hunksPerFile);
  const filePath = `src/${sessionId}/file-${fileIndex}.ts`;
  const liveComments = Array.from({ length: 3 }, (_, commentIndex) => ({
    commentId: `${sessionId}-comment-${updateIndex}-${commentIndex}`,
    filePath,
    hunkIndex,
    side: "new",
    line: hunkIndex * (options.linesPerHunk + 3) + commentIndex + 1,
    summary: `Memory harness comment ${updateIndex}.${commentIndex}`,
    rationale: `Snapshot churn rationale ${sessionId} ${updateIndex} ${commentIndex}`,
    author: "daemon-memory-check",
    createdAt: new Date().toISOString(),
  }));

  return {
    updatedAt: new Date().toISOString(),
    state: {
      selectedFileId: `${sessionId}-file-${fileIndex}`,
      selectedFilePath: filePath,
      selectedHunkIndex: hunkIndex,
      selectedHunkOldRange: [hunkIndex * (options.linesPerHunk + 3) + 1, options.linesPerHunk],
      selectedHunkNewRange: [hunkIndex * (options.linesPerHunk + 3) + 1, options.linesPerHunk],
      showAgentNotes: updateIndex % 2 === 0,
      liveCommentCount: liveComments.length,
      liveComments,
      reviewNoteCount: liveComments.length,
      reviewNotes: liveComments.map((comment) => ({
        noteId: `note-${comment.commentId}`,
        source: "user",
        filePath: comment.filePath,
        hunkIndex: comment.hunkIndex,
        newRange: [comment.line, 1],
        body: comment.rationale,
        title: comment.summary,
        author: comment.author,
        createdAt: comment.createdAt,
        editable: true,
      })),
    },
  };
}

async function openRegisteredSocket(
  port: number,
  sessionId: string,
  cycle: number,
  sessionIndex: number,
  options: CliOptions,
) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out opening websocket for ${sessionId}.`)),
      2_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error(`Websocket failed for ${sessionId}.`));
      },
      { once: true },
    );
  });

  socket.send(
    JSON.stringify({
      type: "register",
      registration: makeRegistration(sessionId, cycle, sessionIndex, options),
      snapshot: makeSnapshot(sessionId, 0, options),
    }),
  );
  return socket;
}

async function sendSnapshotUpdates(
  sockets: WebSocket[],
  sessionIds: string[],
  updatesPerSession: number,
  options: CliOptions,
) {
  for (let updateIndex = 1; updateIndex <= updatesPerSession; updateIndex += 1) {
    for (let sessionIndex = 0; sessionIndex < sockets.length; sessionIndex += 1) {
      sockets[sessionIndex]!.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: sessionIds[sessionIndex],
          snapshot: makeSnapshot(sessionIds[sessionIndex]!, updateIndex, options),
        }),
      );
    }
  }

  // Give the daemon event loop one turn to process the burst before API reads sample the state.
  await Bun.sleep(0);
}

async function postSessionApi(port: number, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}${HUNK_SESSION_API_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Session API ${body.action} failed: ${response.status} ${await response.text()}`,
    );
  }
  await response.arrayBuffer();
}

async function exerciseSessionApi(port: number, sessionIds: string[], requests: number) {
  const actions = ["list", "context", "review", "comment-list"] as const;
  for (let index = 0; index < requests; index += 1) {
    const action = actions[index % actions.length];
    const sessionId = sessionIds[index % sessionIds.length];
    if (action === "list") {
      await postSessionApi(port, { action });
    } else if (action === "review") {
      await postSessionApi(port, {
        action,
        selector: { sessionId },
        includePatch: true,
        includeNotes: true,
      });
    } else {
      await postSessionApi(port, { action, selector: { sessionId } });
    }
  }
}

async function closeSockets(sockets: WebSocket[]) {
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const timeout = setTimeout(resolve, 500);
          socket.addEventListener(
            "close",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
          socket.close();
        }),
    ),
  );
}

async function sample(
  label: string,
  cycle: number,
  pid: number,
  port: number,
): Promise<MemorySample> {
  const [memory, health] = await Promise.all([readProcessMemory(pid), readHealth(port)]);
  return {
    label,
    cycle,
    rssBytes: memory.rssBytes,
    heapBytes: memory.heapBytes,
    highWaterRssBytes: memory.highWaterRssBytes,
    sessions: health?.sessions ?? null,
    pendingCommands: health?.pendingCommands ?? null,
  };
}

function linearSlope(samples: MemorySample[]) {
  if (samples.length < 2) {
    return 0;
  }

  const meanX = samples.reduce((sum, sample) => sum + sample.cycle, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.rssBytes, 0) / samples.length;
  const numerator = samples.reduce(
    (sum, sample) => sum + (sample.cycle - meanX) * (sample.rssBytes - meanY),
    0,
  );
  const denominator = samples.reduce((sum, sample) => sum + (sample.cycle - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = await reserveLoopbackPort();
  const scratch = mkdtempSync(join(tmpdir(), "hunk-daemon-memory-"));
  const child = Bun.spawn([process.execPath, "src/main.tsx", "daemon", "serve"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HUNK_MCP_HOST: "127.0.0.1",
      HUNK_MCP_PORT: String(port),
      HUNK_CONFIG_HOME: scratch,
      HUNK_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const samples: MemorySample[] = [];

  try {
    const health = await waitUntil("daemon health", () => readHealth(port), 10_000);
    const pid = health.pid;
    console.log(`daemon pid=${pid} port=${port}`);
    samples.push(await sample("startup", 0, pid, port));

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      const sockets: WebSocket[] = [];
      const sessionIds = Array.from(
        { length: options.sessionsPerCycle },
        (_, sessionIndex) => `memory-${cycle}-${sessionIndex}`,
      );

      for (let sessionIndex = 0; sessionIndex < sessionIds.length; sessionIndex += 1) {
        sockets.push(
          await openRegisteredSocket(port, sessionIds[sessionIndex]!, cycle, sessionIndex, options),
        );
      }

      await waitUntil("session registration", async () => {
        const nextHealth = await readHealth(port);
        return nextHealth?.sessions === options.sessionsPerCycle ? nextHealth : null;
      });
      await sendSnapshotUpdates(sockets, sessionIds, options.snapshotUpdatesPerCycle, options);
      await exerciseSessionApi(port, sessionIds, options.apiRequestsPerCycle);
      samples.push(await sample("live", cycle, pid, port));

      await closeSockets(sockets);
      await waitUntil("session cleanup", async () => {
        const nextHealth = await readHealth(port);
        return nextHealth?.sessions === 0 ? nextHealth : null;
      });
      await Bun.sleep(options.settleMs);
      const cleanupSample = await sample("cleanup", cycle, pid, port);
      samples.push(cleanupSample);

      console.log(
        `cycle=${cycle.toString().padStart(3)} cleanup_rss=${formatBytes(cleanupSample.rssBytes)} ` +
          `heap=${formatBytes(cleanupSample.heapBytes)} hwm=${formatBytes(cleanupSample.highWaterRssBytes)}`,
      );
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    rmSync(scratch, { recursive: true, force: true });
  }

  const cleanupSamples = samples.filter((entry) => entry.label === "cleanup");
  const analyzedSamples = cleanupSamples.filter((entry) => entry.cycle > options.warmupCycles);
  const first = analyzedSamples[0] ?? cleanupSamples[0] ?? samples[0]!;
  const last = analyzedSamples.at(-1) ?? samples.at(-1)!;
  const slopeBytesPerCycle = linearSlope(analyzedSamples);
  const growthBytes = last.rssBytes - first.rssBytes;
  const maxRssBytes = Math.max(...samples.map((entry) => entry.rssBytes));
  const maxHwmBytes = Math.max(
    ...samples.map((entry) => entry.highWaterRssBytes ?? entry.rssBytes),
  );
  const maxAllowedGrowthBytes = options.maxRssGrowthMb * 1024 * 1024;
  const maxAllowedSlopeBytes = options.maxRssSlopeKb * 1024;
  const passed = growthBytes <= maxAllowedGrowthBytes && slopeBytesPerCycle <= maxAllowedSlopeBytes;

  const summary = {
    options,
    sampleCount: samples.length,
    analyzedCleanupSamples: analyzedSamples.length,
    firstAnalyzedRssBytes: first.rssBytes,
    lastAnalyzedRssBytes: last.rssBytes,
    growthBytes,
    slopeBytesPerCycle,
    maxRssBytes,
    maxHwmBytes,
    passed,
    samples,
  };

  console.log("\nMemory summary");
  console.log(
    `  analyzed cleanup cycles: ${analyzedSamples.length} (warmup=${options.warmupCycles})`,
  );
  console.log(`  first cleanup RSS:       ${formatBytes(first.rssBytes)}`);
  console.log(`  last cleanup RSS:        ${formatBytes(last.rssBytes)}`);
  console.log(`  cleanup RSS growth:      ${formatBytes(growthBytes)}`);
  console.log(`  cleanup RSS slope:       ${formatBytes(slopeBytesPerCycle)} / cycle`);
  console.log(`  max RSS:                 ${formatBytes(maxRssBytes)}`);
  console.log(`  max RSS high-water:      ${formatBytes(maxHwmBytes)}`);
  console.log(`METRIC daemon_rss_growth_bytes=${growthBytes}`);
  console.log(`METRIC daemon_rss_slope_bytes_per_cycle=${slopeBytesPerCycle}`);
  console.log(`METRIC daemon_max_rss_bytes=${maxRssBytes}`);
  console.log(`METRIC daemon_max_hwm_bytes=${maxHwmBytes}`);

  if (options.jsonOut) {
    await Bun.write(options.jsonOut, JSON.stringify(summary, null, 2));
    console.log(`wrote ${options.jsonOut}`);
  }

  if (!passed) {
    console.error(
      `Daemon memory growth exceeded threshold: growth=${formatBytes(growthBytes)} ` +
        `(limit ${options.maxRssGrowthMb} MiB), slope=${formatBytes(slopeBytesPerCycle)}/cycle ` +
        `(limit ${options.maxRssSlopeKb} KiB/cycle).`,
    );
    process.exit(1);
  }
}

await main().catch(async (error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
