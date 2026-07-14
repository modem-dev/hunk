import { existsSync, readFileSync } from "node:fs";
import type { IdleSample } from "./schema";

export interface ProcessSnapshot {
  cpuTimeMs: number;
  rssBytes: number;
  alive: boolean;
}

export interface ProcessSampler {
  sample(pid: number): ProcessSnapshot;
}

export interface SamplerSystem {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  fileExists(path: string): boolean;
  run(command: string[]): string;
  isAlive(pid: number): boolean;
}

const defaultSystem: SamplerSystem = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  fileExists: existsSync,
  run(command) {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(Buffer.from(result.stderr).toString("utf8").trim() || `${command[0]} failed`);
    }
    return Buffer.from(result.stdout).toString("utf8");
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

/** Parse the portable ps cumulative CPU format: [[dd-]hh:]mm:ss[.fraction]. */
export function parsePsCpuTime(value: string): number {
  const trimmed = value.trim();
  const dayParts = trimmed.split("-");
  if (dayParts.length > 2) throw new Error(`Invalid ps CPU time: ${value}`);
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const time = dayParts.at(-1)!.split(":").map(Number);
  if (time.some((part) => !Number.isFinite(part)) || time.length < 2 || time.length > 3) {
    throw new Error(`Invalid ps CPU time: ${value}`);
  }
  const seconds = time.at(-1)!;
  const minutes = time.at(-2)!;
  const hours = time.length === 3 ? time[0]! : 0;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

/** Sample Linux directly from procfs to avoid adding a process per interval. */
function sampleLinux(pid: number, system: SamplerSystem, ticksPerSecond: number): ProcessSnapshot {
  const statPath = `/proc/${pid}/stat`;
  const statusPath = `/proc/${pid}/status`;
  if (!system.fileExists(statPath)) return { cpuTimeMs: 0, rssBytes: 0, alive: false };
  const stat = system.readFile(statPath);
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error(`Malformed ${statPath}`);
  const fieldsAfterCommand = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fieldsAfterCommand[11]);
  const systemTicks = Number(fieldsAfterCommand[12]);
  if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) {
    throw new Error(`Malformed CPU fields in ${statPath}`);
  }
  const status = system.readFile(statusPath);
  const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!rssMatch) throw new Error(`Missing VmRSS in ${statusPath}`);
  return {
    cpuTimeMs: ((userTicks + systemTicks) / ticksPerSecond) * 1_000,
    rssBytes: Number(rssMatch[1]) * 1_024,
    alive: true,
  };
}

/** Sample macOS and other Unix hosts through one ps snapshot. */
function samplePs(pid: number, system: SamplerSystem): ProcessSnapshot {
  if (!system.isAlive(pid)) return { cpuTimeMs: 0, rssBytes: 0, alive: false };
  const output = system.run(["ps", "-o", "time=", "-o", "rss=", "-p", String(pid)]).trim();
  const match = /^(.*?)\s+(\d+)$/.exec(output);
  if (!match) throw new Error(`Malformed ps sample: ${output}`);
  return {
    cpuTimeMs: parsePsCpuTime(match[1]!),
    rssBytes: Number(match[2]) * 1_024,
    alive: true,
  };
}

/** Sample Windows cumulative CPU and working set through its stable PowerShell process API. */
function sampleWindows(pid: number, system: SamplerSystem): ProcessSnapshot {
  if (!system.isAlive(pid)) return { cpuTimeMs: 0, rssBytes: 0, alive: false };
  const script =
    `$p=Get-Process -Id ${pid} -ErrorAction Stop;` +
    `[Console]::Write((@{cpuMs=$p.TotalProcessorTime.TotalMilliseconds;rss=$p.WorkingSet64}|ConvertTo-Json -Compress))`;
  const parsed = JSON.parse(
    system.run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]),
  ) as { cpuMs?: unknown; rss?: unknown };
  if (typeof parsed.cpuMs !== "number" || typeof parsed.rss !== "number") {
    throw new Error("Malformed PowerShell process sample");
  }
  return { cpuTimeMs: parsed.cpuMs, rssBytes: parsed.rss, alive: true };
}

/** Create one host adapter for live cumulative process CPU and RSS sampling. */
export function createProcessSampler(system: SamplerSystem = defaultSystem): ProcessSampler {
  let ticksPerSecond = 100;
  if (system.platform === "linux") {
    const parsed = Number(system.run(["getconf", "CLK_TCK"]).trim());
    if (Number.isFinite(parsed) && parsed > 0) ticksPerSecond = parsed;
  }
  return {
    sample(pid) {
      if (system.platform === "linux") return sampleLinux(pid, system, ticksPerSecond);
      if (system.platform === "win32") return sampleWindows(pid, system);
      return samplePs(pid, system);
    },
  };
}

export interface SamplingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: SamplingClock = {
  now: () => performance.now(),
  sleep: Bun.sleep,
};

/** Collect cumulative samples at exact protocol offsets without drifting each next deadline. */
export async function collectIdleSamples(options: {
  pid: number;
  durationMs: number;
  intervalMs: number;
  sampler?: ProcessSampler;
  clock?: SamplingClock;
  degraded?: () => boolean | null;
}): Promise<IdleSample[]> {
  if (options.durationMs % options.intervalMs !== 0) {
    throw new Error("Idle duration must be evenly divisible by its sample interval");
  }
  const sampler = options.sampler ?? createProcessSampler();
  const clock = options.clock ?? defaultClock;
  const startedAt = clock.now();
  const samples: IdleSample[] = [];

  for (let elapsedMs = 0; elapsedMs <= options.durationMs; elapsedMs += options.intervalMs) {
    const remaining = startedAt + elapsedMs - clock.now();
    if (remaining > 0) await clock.sleep(remaining);
    try {
      const snapshot = sampler.sample(options.pid);
      samples.push({
        elapsedMs,
        cpuTimeMs: snapshot.cpuTimeMs,
        rssBytes: snapshot.rssBytes,
        alive: snapshot.alive,
        degraded: options.degraded?.() ?? null,
        error: null,
      });
    } catch (error) {
      samples.push({
        elapsedMs,
        cpuTimeMs: null,
        rssBytes: null,
        alive: false,
        degraded: options.degraded?.() ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return samples;
}
