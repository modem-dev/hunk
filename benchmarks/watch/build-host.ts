#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  WATCH_HOST_IDS,
  verifyCampaignInputs,
  writeCampaignJson,
  type CampaignManifest,
  type WatchHostId,
} from "./campaign";
import { verifyFixtureArtifacts } from "./fixture";
import { assertWatchHostIdentity } from "./host-identity";
import {
  binaryProvenanceFileSchema,
  campaignConfigSchema,
  verifyBinaryProvenance,
  type BinaryProvenanceFile,
} from "./schema";

export type BuildRevision = "base" | "candidate";

export interface HostBuildOptions {
  campaignRoot: string;
  hostId: WatchHostId;
  bunPath: string;
}

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Select the native standalone binary filename for this host. */
export function compiledBinaryName(hostPlatform: NodeJS.Platform): "hunk" | "hunk.exe" {
  return hostPlatform === "win32" ? "hunk.exe" : "hunk";
}

/** Alternate build order by a stable host/campaign seed. */
export function hostBuildOrder(campaignId: string, hostId: string): BuildRevision[] {
  const firstByte = createHash("sha256").update(`${campaignId}\0${hostId}`).digest()[0]!;
  return firstByte % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
}

/** Return commands that can only invoke the explicitly pinned Bun executable. */
export function exactBuildCommands(bunPath: string): {
  installCommand: string[];
  buildCommand: string[];
} {
  return {
    installCommand: [bunPath, "install", "--frozen-lockfile"],
    buildCommand: [bunPath, "run", "./scripts/build-bin.ts"],
  };
}

/** Build the PowerShell checksum invocation without interpolating a possibly spaced path. */
export function windowsChecksumCommand(
  path: string,
  expectedSha256: string,
  executable = process.env.GITHUB_ACTIONS === "true" ? "pwsh.exe" : "powershell.exe",
): string[] {
  return [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    '& { param($Path,$Expected) $Actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant(); if ($Actual -cne $Expected) { throw "SHA256 mismatch" } }',
    path,
    expectedSha256,
  ];
}

/** Decode and validate the native architecture from a PE/COFF header. */
export function parsePeArchitecture(bytes: Uint8Array): "arm64" | "x64" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 64 || view.getUint16(0, true) !== 0x5a4d) {
    throw new Error("Binary does not contain a DOS MZ header");
  }
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 6 > bytes.byteLength || view.getUint32(peOffset, true) !== 0x00004550) {
    throw new Error("Binary does not contain a valid PE signature");
  }
  const machine = view.getUint16(peOffset + 4, true);
  if (machine === 0xaa64) return "arm64";
  if (machine === 0x8664) return "x64";
  throw new Error(`Unsupported PE machine type: 0x${machine.toString(16)}`);
}

/** Return the platform-mandated SHA256 and record which tool produced it. */
function platformChecksum(path: string): {
  sha256: string;
  tool: BinaryProvenanceFile["checksumTool"];
} {
  if (process.platform === "win32") {
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    const result = run(windowsChecksumCommand(path, sha256));
    if (result.exitCode !== 0) {
      throw new Error(`Get-FileHash verification failed: ${text(result.stderr)}`);
    }
    return { sha256, tool: "Get-FileHash SHA256" };
  }

  const command =
    process.platform === "darwin" ? ["shasum", "-a", "256", path] : ["sha256sum", path];
  const result = run(command);
  if (result.exitCode !== 0)
    throw new Error(`Binary checksum command failed: ${text(result.stderr)}`);
  const sha256 = text(result.stdout).trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("Checksum tool returned invalid SHA256");
  return {
    sha256,
    tool: process.platform === "darwin" ? "shasum -a 256" : "sha256sum",
  };
}

/** Inspect executable architecture without trusting its filename. */
function inspectFileArchitecture(path: string): string {
  if (process.platform === "win32") return `PE32+ ${parsePeArchitecture(readFileSync(path))}`;
  const result = run(["file", "-b", path]);
  if (result.exitCode !== 0)
    throw new Error(`file architecture probe failed: ${text(result.stderr)}`);
  const description = text(result.stdout).trim();
  const expectedPattern = process.arch === "arm64" ? /(arm64|aarch64)/i : /(x86[-_ ]?64|x86_64)/i;
  if (!expectedPattern.test(description)) {
    throw new Error(`Binary architecture does not match process architecture: ${description}`);
  }
  return description;
}

/** Run one command with byte-exact output capture. */
function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CommandResult {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: Uint8Array.from(proc.stdout),
    stderr: Uint8Array.from(proc.stderr),
  };
}

/** Decode captured command output for diagnostics only. */
function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** Run Git without user configuration, credentials, or terminal prompts. */
function git(cwd: string, args: string[]): string {
  const result = run(["git", ...args], {
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).flatMap(([key, value]) => (value ? [[key, value]] : [])),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(text(result.stderr).trim() || `git ${args.join(" ")} failed`);
  return text(result.stdout);
}

/** Query the exact Bun executable rather than accepting any PATH fallback. */
function inspectPinnedBun(bunPath: string): {
  path: string;
  version: "1.3.14";
  arch: "arm64" | "x64";
} {
  if (!resolve(bunPath) || !existsSync(bunPath))
    throw new Error(`Pinned Bun does not exist: ${bunPath}`);
  const absolutePath = resolve(bunPath);
  if (absolutePath !== bunPath) throw new Error("Pinned Bun path must be absolute and normalized");
  const result = run([
    absolutePath,
    "-e",
    "process.stdout.write(JSON.stringify({version:Bun.version,arch:process.arch}))",
  ]);
  if (result.exitCode !== 0) throw new Error(`Pinned Bun probe failed: ${text(result.stderr)}`);
  const info = JSON.parse(text(result.stdout)) as { version?: unknown; arch?: unknown };
  if (info.version !== "1.3.14")
    throw new Error(`Pinned Bun must be 1.3.14; found ${info.version}`);
  if (info.arch !== process.arch || !["arm64", "x64"].includes(String(info.arch))) {
    throw new Error(`Pinned Bun architecture does not match host process: ${String(info.arch)}`);
  }
  return { path: absolutePath, version: "1.3.14", arch: info.arch as "arm64" | "x64" };
}

/** Validate that the currently executing harness is the separately frozen harness commit. */
function verifyHarnessSha(manifest: CampaignManifest): void {
  const harnessRoot = dirname(dirname(import.meta.dir));
  if (git(harnessRoot, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Error("Frozen harness tracked state must be clean");
  }
  const actual = git(harnessRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (actual !== manifest.revisions.harness.sourceSha) {
    throw new Error(
      `Host build must run from frozen harness ${manifest.revisions.harness.sourceSha}`,
    );
  }
}

/** Require every advertised bundle ref to equal its frozen manifest SHA. */
function verifyBundleRefs(campaignRoot: string, manifest: CampaignManifest): void {
  const bundle = join(campaignRoot, "inputs", "hunk.bundle");
  const heads = new Map(
    git(campaignRoot, ["bundle", "list-heads", bundle])
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/, 2);
        return [ref!, sha!.toLowerCase()];
      }),
  );
  const expected = {
    [manifest.bundleRefs.base]: manifest.revisions.base.sourceSha,
    [manifest.bundleRefs.candidate]: manifest.revisions.candidate.sourceSha,
    [manifest.bundleRefs.harness]: manifest.revisions.harness.sourceSha,
    [manifest.bundleRefs.littleFixtureSource]: manifest.fixtures["little-repo"].sourceSha,
  };
  for (const [ref, sha] of Object.entries(expected)) {
    if (heads.get(ref) !== sha) throw new Error(`Transferred bundle ref mismatch: ${ref}`);
  }
}

/** Create one credential-free detached checkout at an exact frozen bundle ref. */
function createBuildCheckout(options: {
  campaignRoot: string;
  destination: string;
  ref: string;
  expectedSha: string;
}): void {
  if (existsSync(options.destination))
    throw new Error(`Build checkout already exists: ${options.destination}`);
  mkdirSync(options.destination, { recursive: true });
  git(options.destination, ["init", "--quiet"]);
  git(options.destination, ["config", "core.autocrlf", "false"]);
  git(options.destination, [
    "fetch",
    "--quiet",
    "--no-tags",
    join(options.campaignRoot, "inputs", "hunk.bundle"),
    options.ref,
  ]);
  const fetched = git(options.destination, ["rev-parse", "FETCH_HEAD^{commit}"])
    .trim()
    .toLowerCase();
  if (fetched !== options.expectedSha) throw new Error("Bundle checkout SHA mismatch");
  git(options.destination, ["checkout", "--quiet", "--detach", fetched]);
  if (git(options.destination, ["remote"]).trim())
    throw new Error("Build checkout retained a remote");
}

/** Append captured install/build streams to immutable per-revision logs. */
function writeBuildLogs(path: string, chunks: Uint8Array[]): void {
  writeFileSync(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), { flag: "wx" });
}

/** Recover only a manifest-owned incomplete revision before opening a new build attempt. */
export function prepareRevisionBuildAttempt(options: {
  markerPath: string;
  campaignId: string;
  hostId: WatchHostId;
  revision: BuildRevision;
  ownedPaths: string[];
}): void {
  if (existsSync(options.markerPath)) {
    const marker = JSON.parse(readFileSync(options.markerPath, "utf8")) as Record<string, unknown>;
    if (
      marker.campaignId !== options.campaignId ||
      marker.hostId !== options.hostId ||
      marker.revision !== options.revision
    ) {
      throw new Error(`Incomplete build marker ownership mismatch: ${options.markerPath}`);
    }
    for (const path of options.ownedPaths) rmSync(path, { recursive: true, force: true });
    rmSync(options.markerPath);
  } else if (options.ownedPaths.some(existsSync)) {
    throw new Error(`Refusing unowned incomplete build paths for ${options.revision}`);
  }
  mkdirSync(dirname(options.markerPath), { recursive: true });
  writeFileSync(
    options.markerPath,
    `${JSON.stringify({
      schemaVersion: 1,
      campaignId: options.campaignId,
      hostId: options.hostId,
      revision: options.revision,
    })}\n`,
    { flag: "wx" },
  );
}

/** Build both frozen revisions and emit rich executable provenance plus runner config. */
export function buildHostCampaign(options: HostBuildOptions): BinaryProvenanceFile[] {
  if (!WATCH_HOST_IDS.includes(options.hostId))
    throw new Error(`Unknown watch host: ${options.hostId}`);
  const campaignRoot = resolve(options.campaignRoot);
  const manifest = verifyCampaignInputs(campaignRoot);
  assertWatchHostIdentity(options.hostId);
  verifyHarnessSha(manifest);
  verifyBundleRefs(campaignRoot, manifest);
  verifyFixtureArtifacts(join(campaignRoot, "inputs", "fixtures", "little-repo"));
  verifyFixtureArtifacts(join(campaignRoot, "inputs", "fixtures", "big-repo"));
  const bun = inspectPinnedBun(options.bunPath);
  const order = hostBuildOrder(manifest.campaignId, options.hostId);
  const outputHostRoot = join(campaignRoot, "hosts", options.hostId);
  const provenanceDir = join(outputHostRoot, "provenance");
  const logsDir = join(outputHostRoot, "build-logs");
  const binariesDir = join(outputHostRoot, "bin");
  for (const directory of [provenanceDir, logsDir, binariesDir])
    mkdirSync(directory, { recursive: true });
  const records: BinaryProvenanceFile[] = [];

  for (const [orderIndex, revision] of order.entries()) {
    const revisionManifest = manifest.revisions[revision];
    const checkout = join(campaignRoot, "build", revision);
    const binaryName = compiledBinaryName(process.platform);
    const immutableDir = join(binariesDir, revision);
    const executablePath = resolve(immutableDir, binaryName);
    const stdoutLogPath = resolve(logsDir, `${revision}.stdout.log`);
    const stderrLogPath = resolve(logsDir, `${revision}.stderr.log`);
    const provenancePath = resolve(provenanceDir, `${revision}.json`);
    const markerPath = resolve(outputHostRoot, "build-state", `${revision}.json`);
    if (existsSync(provenancePath)) {
      records.push(
        verifyBinaryProvenance(
          revision,
          executablePath,
          provenancePath,
          revisionManifest.sourceSha,
        ),
      );
      continue;
    }
    prepareRevisionBuildAttempt({
      markerPath,
      campaignId: manifest.campaignId,
      hostId: options.hostId,
      revision,
      ownedPaths: [checkout, immutableDir, stdoutLogPath, stderrLogPath],
    });
    createBuildCheckout({
      campaignRoot,
      destination: checkout,
      ref: manifest.bundleRefs[revision],
      expectedSha: revisionManifest.sourceSha,
    });
    mkdirSync(immutableDir);

    const { installCommand, buildCommand } = exactBuildCommands(bun.path);
    const buildEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).flatMap(([key, value]) => (value ? [[key, value]] : [])),
      ),
      PATH: `${dirname(bun.path)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1",
    };
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const startedAt = new Date();
    const startedMs = performance.now();
    let commandFailure: string | null = null;
    for (const command of [installCommand, buildCommand]) {
      const result = run(command, { cwd: checkout, env: buildEnvironment });
      stdoutChunks.push(result.stdout);
      stderrChunks.push(result.stderr);
      if (result.exitCode !== 0) {
        commandFailure = `${command.slice(1).join(" ")} failed: ${text(result.stderr).trim()}`;
        break;
      }
    }
    const durationMs = performance.now() - startedMs;
    const finishedAt = new Date();
    writeBuildLogs(stdoutLogPath, stdoutChunks);
    writeBuildLogs(stderrLogPath, stderrChunks);
    if (commandFailure) throw new Error(commandFailure);
    const builtPath = join(checkout, "dist", binaryName);
    if (!existsSync(builtPath)) throw new Error(`Build did not produce ${binaryName}`);
    copyFileSync(builtPath, executablePath, fsConstants.COPYFILE_EXCL);
    if (process.platform !== "win32") chmodSync(executablePath, 0o755);

    const checksum = platformChecksum(executablePath);
    const fileArchitecture = inspectFileArchitecture(executablePath);
    const smokeCommand = [executablePath, "--help"];
    const smoke = run(smokeCommand);
    if (smoke.exitCode !== 0)
      throw new Error(`Absolute-path smoke invocation failed: ${text(smoke.stderr)}`);

    const provenance = binaryProvenanceFileSchema.parse({
      schemaVersion: 1,
      revision,
      sourceSha: revisionManifest.sourceSha,
      executablePath,
      sha256: checksum.sha256,
      sizeBytes: statSync(executablePath).size,
      platform: platform(),
      arch: arch(),
      fileArchitecture,
      processArchitecture: process.arch,
      host: { hostname: hostname(), platform: platform(), release: release(), arch: arch() },
      bun,
      build: {
        installCommand,
        command: buildCommand,
        environment: {
          PATH: buildEnvironment.PATH,
          SKIP_INSTALL_SIMPLE_GIT_HOOKS: buildEnvironment.SKIP_INSTALL_SIMPLE_GIT_HOOKS,
        },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        order: orderIndex + 1,
        stdoutLogPath,
        stderrLogPath,
      },
      checksumTool: checksum.tool,
      invocation:
        process.platform === "win32" && process.arch === "arm64"
          ? {
              // Bun 1.3.14 standalone ARM64 executables cannot dlopen OpenTUI's FFI library.
              // Keep the compiled PE as build evidence, but use the exact native Bun source command
              // for this preflight adapter until compiled ARM64 FFI is available.
              mode: "bun-source-windows-arm64",
              command: [bun.path, resolve(checkout, "src", "main.tsx")],
              sourceEntrySha256: createHash("sha256")
                .update(readFileSync(resolve(checkout, "src", "main.tsx")))
                .digest("hex"),
            }
          : {
              mode: "compiled",
              command: [executablePath],
              sourceEntrySha256: null,
            },
      smoke: {
        command: smokeCommand,
        exitCode: 0,
        stdoutSha256: createHash("sha256").update(smoke.stdout).digest("hex"),
        stderrSha256: createHash("sha256").update(smoke.stderr).digest("hex"),
        succeeded: true,
      },
    });
    writeCampaignJson(provenancePath, provenance);
    rmSync(markerPath);
    records.push(provenance);
  }

  const byRevision = Object.fromEntries(
    records.map((record) => [record.revision, record]),
  ) as Record<BuildRevision, BinaryProvenanceFile>;
  const runnerConfig = campaignConfigSchema.parse({
    schemaVersion: 1,
    campaignId: manifest.campaignId,
    hostId: options.hostId,
    expectedHarnessSha: manifest.revisions.harness.sourceSha,
    protocolVersion: manifest.protocolVersion,
    orderSeed: manifest.orderSeed,
    preflightOnly: manifest.preflightOnly,
    outputDir: campaignRoot,
    binaries: Object.fromEntries(
      (["base", "candidate"] as const).map((revision) => [
        revision,
        {
          executablePath: byRevision[revision].executablePath,
          provenancePath: resolve(provenanceDir, `${revision}.json`),
          expectedSourceSha: manifest.revisions[revision].sourceSha,
        },
      ]),
    ),
    fixtures: (["little-repo", "big-repo"] as const).map((id) => ({
      id,
      label: id === "little-repo" ? "little repo" : "big repo",
      artifactsDir: resolve(campaignRoot, "inputs", "fixtures", id),
      repoDir: resolve(campaignRoot, "work", "fixtures", id),
      manifestSha256: manifest.fixtures[id].manifestSha256,
      requiredScreenText: [".hunk-benchmark/tracked.txt", "standard dirty"],
    })),
    startupTimeoutMs: 30_000,
    refreshTimeoutMs: 10_000,
    idleDurationMs: 120_000,
    idleSampleIntervalMs: 10_000,
    refreshTrials: 5,
  });
  writeCampaignJson(join(outputHostRoot, "campaign.json"), runnerConfig);
  return records;
}

/** Read one required CLI option. */
function cliOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

if (import.meta.main) {
  try {
    const records = buildHostCampaign({
      campaignRoot: cliOption(process.argv, "--campaign-root"),
      hostId: cliOption(process.argv, "--host-id") as WatchHostId,
      bunPath: cliOption(process.argv, "--bun"),
    });
    process.stdout.write(`${records.length} immutable binaries built\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
