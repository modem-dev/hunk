#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { arch, homedir, hostname, platform, release } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { WATCH_HOST_IDS, type WatchHostId } from "./campaign";
import { assertWatchHostIdentity } from "./host-identity";

export interface WatchHostProfile {
  hostId: WatchHostId;
  endpoint: string | null;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  workspace: string;
  bunPath: string;
  filesystem: "APFS" | "NTFS" | "record-only";
  notes: string[];
}

export const WATCH_HOST_PROFILES: Record<WatchHostId, WatchHostProfile> = {
  "macos-arm64-aarmstrong": {
    hostId: "macos-arm64-aarmstrong",
    endpoint: "justin@100.65.101.78",
    platform: "darwin",
    arch: "arm64",
    workspace: "/Users/justin/hunk-watch-campaigns",
    bunPath: "/Users/justin/.hunk-watch-tools/bun-1.3.14/bin/bun",
    filesystem: "APFS",
    notes: [
      "Use the isolated Bun path, not system Bun 1.3.11",
      "Require AC power and lowpowermode=0",
    ],
  },
  "linux-x64-sentry-agent": {
    hostId: "linux-x64-sentry-agent",
    endpoint: "justin@100.125.201.29",
    platform: "linux",
    arch: "x64",
    workspace: "/home/justin/hunk-watch-campaigns",
    bunPath: "/home/justin/.bun/bin/bun",
    filesystem: "record-only",
    notes: [
      "Record /proc/sys/fs/inotify/max_user_watches (expected observed value 61504)",
      "Never alter ~/perf without explicit orchestrator approval and campaign ownership verification",
    ],
  },
  "windows-arm64-hunk-windows": {
    hostId: "windows-arm64-hunk-windows",
    endpoint: "hunk@hunk-windows.tail95b37.ts.net",
    platform: "win32",
    arch: "arm64",
    workspace: "C:\\DEV\\hunk-watch-campaigns",
    bunPath: "C:\\Users\\hunk\\.bun\\bin\\bun.exe",
    filesystem: "NTFS",
    notes: ["Require native ARM64 Bun and binary processes"],
  },
  "windows-x64-gha": {
    hostId: "windows-x64-gha",
    endpoint: null,
    platform: "win32",
    arch: "x64",
    workspace: "D:\\a\\hunk-watch-campaigns",
    bunPath: "setup-bun-1.3.14",
    filesystem: "NTFS",
    notes: ["Use the pinned setup-bun 1.3.14 workflow and upload the complete host campaign tree"],
  },
  "macos-arm64-currie": {
    hostId: "macos-arm64-currie",
    endpoint: null,
    platform: "darwin",
    arch: "arm64",
    workspace: "/Users/justin/DEV/hunk-watch-campaigns",
    bunPath: "/absolute/path/to/bun-1.3.14",
    filesystem: "APFS",
    notes: ["Supplemental host only"],
  },
};

/** Return the nearest existing ancestor for read-only filesystem and capacity probes. */
function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return parse(current).root;
    current = parent;
  }
  return current;
}

/** Run a read-only host probe and return trimmed output. */
function probe(command: string[]): string {
  const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (proc.exitCode !== 0) {
    throw new Error(
      Buffer.from(proc.stderr).toString("utf8").trim() || `${command[0]} probe failed`,
    );
  }
  return Buffer.from(proc.stdout).toString("utf8").trim();
}

/** Verify an exact Bun executable and native process architecture. */
function inspectPinnedBun(bunPath: string, expectedArch: "arm64" | "x64"): object {
  if (!existsSync(bunPath)) throw new Error(`Pinned Bun is missing: ${bunPath}`);
  const bun = JSON.parse(
    probe([
      bunPath,
      "-e",
      "process.stdout.write(JSON.stringify({version:Bun.version,arch:process.arch}))",
    ]),
  ) as { version?: unknown; arch?: unknown };
  if (bun.version !== "1.3.14" || bun.arch !== expectedArch) {
    throw new Error(`Pinned Bun mismatch: ${String(bun.version)}/${String(bun.arch)}`);
  }
  return { path: bunPath, version: bun.version, arch: bun.arch };
}

/** Install aarmstrong's pinned Bun into a new isolated, version-owned path. */
export function installAarmstrongPinnedBun(
  profile = WATCH_HOST_PROFILES["macos-arm64-aarmstrong"],
): object {
  if (profile.hostId !== "macos-arm64-aarmstrong") {
    throw new Error("The isolated Bun installer is only configured for aarmstrong");
  }
  assertWatchHostIdentity(profile.hostId);
  if (existsSync(profile.bunPath)) return inspectPinnedBun(profile.bunPath, "arm64");
  const installRoot = dirname(dirname(profile.bunPath));
  if (existsSync(installRoot)) {
    throw new Error(`Refusing to replace incomplete isolated Bun path: ${installRoot}`);
  }
  const parent = dirname(installRoot);
  mkdirSync(parent, { recursive: true });
  const incoming = mkdtempSync(`${parent}/.bun-1.3.14-incoming-`);
  try {
    const archive = `${incoming}/bun.zip`;
    probe([
      "curl",
      "--fail",
      "--location",
      "--output",
      archive,
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip",
    ]);
    const unpacked = `${incoming}/unpacked`;
    mkdirSync(unpacked);
    probe(["unzip", "-q", archive, "-d", unpacked]);
    mkdirSync(`${incoming}/bin`);
    copyFileSync(`${unpacked}/bun-darwin-aarch64/bun`, `${incoming}/bin/bun`);
    chmodSync(`${incoming}/bin/bun`, 0o755);
    rmSync(archive);
    rmSync(unpacked, { recursive: true });
    inspectPinnedBun(`${incoming}/bin/bun`, "arm64");
    renameSync(incoming, installRoot);
    return inspectPinnedBun(profile.bunPath, "arm64");
  } catch (error) {
    rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}

/** Require AC power and low-power mode zero in the currently active macOS settings. */
export function assertMacPowerState(battery: string, activePower: string): void {
  if (!/AC Power/i.test(battery) || !/(?:low)?powermode\s+0/i.test(activePower)) {
    throw new Error("macOS host must be on AC power with active low-power mode disabled");
  }
}

/** Perform non-mutating host, Bun, filesystem, power, and capacity checks. */
export function preflightHost(profile: WatchHostProfile, bunPath = profile.bunPath): object {
  assertWatchHostIdentity(profile.hostId);
  const bun = inspectPinnedBun(bunPath, profile.arch);
  const ancestor = existingAncestor(profile.workspace);
  const macMountPoint =
    process.platform === "darwin"
      ? probe(["df", "-P", ancestor]).split(/\r?\n/).at(-1)?.trim().split(/\s+/).at(-1)
      : undefined;
  const filesystem =
    process.platform === "darwin"
      ? probe(["diskutil", "info", macMountPoint ?? "/"])
      : process.platform === "linux"
        ? probe(["findmnt", "-no", "FSTYPE,TARGET", "--target", ancestor])
        : probe([
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "& { param($Path) $item=Get-Item -LiteralPath $Path; $drive=$item.PSDrive.Name; $v=Get-Volume -DriveLetter $drive; @{FileSystem=$v.FileSystem;DriveLetter=$drive}|ConvertTo-Json -Compress }",
            ancestor,
          ]);
  if (profile.filesystem === "APFS" && !/APFS/i.test(filesystem))
    throw new Error("Workspace is not APFS");
  if (profile.filesystem === "NTFS" && !/NTFS/i.test(filesystem))
    throw new Error("Workspace is not NTFS");

  let power: string | null = null;
  let inotifyMaxUserWatches: number | null = null;
  let legacyPerf: { path: string; exists: boolean; action: "inspection-only" } | null = null;
  if (process.platform === "darwin") {
    const battery = probe(["pmset", "-g", "batt"]);
    const activePower = probe(["pmset", "-g"]);
    const configuredPower = probe(["pmset", "-g", "custom"]);
    power = `${battery}\nActive settings:\n${activePower}\nConfigured profiles:\n${configuredPower}`;
    assertMacPowerState(battery, activePower);
  } else if (process.platform === "linux") {
    inotifyMaxUserWatches = Number(
      readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim(),
    );
    const perfPath = `${homedir()}/perf`;
    legacyPerf = { path: perfPath, exists: existsSync(perfPath), action: "inspection-only" };
  }
  const capacity = statfsSync(ancestor);
  const availableBytes = capacity.bavail * capacity.bsize;
  if (availableBytes < 2 * 1_024 * 1_024 * 1_024) {
    throw new Error(`Host has less than 2 GiB available at ${ancestor}`);
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    hostId: profile.hostId,
    hostname: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    bun,
    workspace: profile.workspace,
    existingWorkspaceAncestor: ancestor,
    filesystem,
    availableBytes,
    power,
    inotifyMaxUserWatches,
    legacyPerf,
    notes: profile.notes,
  };
}

/** Produce a safe plan without contacting or mutating any host. */
export function dryRunHostPreflight(profile: WatchHostProfile): object {
  return {
    mode: "dry-run",
    mutatesHost: false,
    ...profile,
    checks: [
      "host OS/architecture",
      "exact Bun 1.3.14 path and architecture",
      "filesystem",
      "free disk",
    ],
  };
}

function cliOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  try {
    const hostId = cliOption(process.argv, "--host-id") as WatchHostId | undefined;
    if (!hostId || !WATCH_HOST_IDS.includes(hostId))
      throw new Error("Missing or invalid --host-id");
    const profile = WATCH_HOST_PROFILES[hostId];
    const result = process.argv.includes("--dry-run")
      ? dryRunHostPreflight(profile)
      : process.argv.includes("--install-isolated-bun")
        ? installAarmstrongPinnedBun(profile)
        : preflightHost(profile, cliOption(process.argv, "--bun") ?? profile.bunPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
