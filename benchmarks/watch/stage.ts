#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  WATCH_HOST_IDS,
  campaignFileSha256,
  verifyCampaignInputs,
  type WatchHostId,
} from "./campaign";
import { WATCH_HOST_PROFILES, type WatchHostProfile } from "./host-preflight";

export interface StagePlan {
  hostId: WatchHostId;
  endpoint: string | null;
  campaignId: string;
  finalPath: string;
  incomingPath: string;
  manifestSha256: string;
  probeCommand: string[] | null;
  initializeCommand: string[] | null;
  scpDestination: string | null;
  finalizeCommand: string[] | null;
  mutatesExistingPaths: false;
}

/** Quote one literal for a POSIX remote shell. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Quote one literal for a PowerShell script. */
export function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Encode PowerShell so SSH does not reinterpret spaces or metacharacters in Windows paths. */
export function encodedPowerShellCommand(script: string): string[] {
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/** Build one SCP argv value; Bun.spawn preserves spaces without remote-shell quote characters. */
export function scpRemoteSpec(endpoint: string, remotePath: string): string {
  return `${endpoint}:${remotePath.replaceAll("\\", "/")}`;
}

/** Build a deterministic, ownership-safe transfer plan for one frozen campaign. */
export function createStagePlan(campaignRoot: string, profile: WatchHostProfile): StagePlan {
  const manifest = verifyCampaignInputs(campaignRoot);
  const manifestSha256 = campaignFileSha256(join(campaignRoot, "campaign-manifest.json"));
  const pathApi = profile.platform === "win32" ? win32 : posix;
  const finalPath = pathApi.join(profile.workspace, "campaigns", manifest.campaignId);
  const incomingPath = `${finalPath}.incoming-${manifestSha256.slice(0, 8)}`;
  if (!profile.endpoint) {
    return {
      hostId: profile.hostId,
      endpoint: null,
      campaignId: manifest.campaignId,
      finalPath,
      incomingPath,
      manifestSha256,
      probeCommand: null,
      initializeCommand: null,
      scpDestination: null,
      finalizeCommand: null,
      mutatesExistingPaths: false,
    };
  }

  if (profile.platform === "win32") {
    const final = quotePowerShell(finalPath);
    const incoming = quotePowerShell(incomingPath);
    const parent = quotePowerShell(pathApi.dirname(finalPath));
    const archive = quotePowerShell(pathApi.join(incomingPath, "campaign-inputs.tar"));
    const manifestPath = quotePowerShell(pathApi.join(finalPath, "campaign-manifest.json"));
    const ownerPath = quotePowerShell(pathApi.join(incomingPath, ".hunk-campaign-owner"));
    const ownerValues = `@(${quotePowerShell(manifest.campaignId)},${quotePowerShell(manifestSha256)})`;
    const probe =
      `$final=${final};$incoming=${incoming};$manifest=${manifestPath};$owner=${ownerPath};` +
      `if(Test-Path -LiteralPath $manifest){(Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant()}` +
      `elseif(Test-Path -LiteralPath $final){'BLOCKED'}` +
      `elseif(Test-Path -LiteralPath $owner){$values=Get-Content -LiteralPath $owner;` +
      `if($values[0] -eq ${quotePowerShell(manifest.campaignId)} -and $values[1] -eq ${quotePowerShell(manifestSha256)}){'INCOMING:'+${quotePowerShell(manifestSha256)}}else{'BLOCKED-INCOMING'}}` +
      `elseif(Test-Path -LiteralPath $incoming){'BLOCKED-INCOMING'}else{'MISSING'}`;
    const initialize =
      `$ErrorActionPreference='Stop';$final=${final};$incoming=${incoming};$owner=${ownerPath};` +
      `if((Test-Path -LiteralPath $final)-or(Test-Path -LiteralPath $incoming)){throw 'stage destination exists'};` +
      `New-Item -ItemType Directory -Force -Path ${parent}|Out-Null;` +
      `New-Item -ItemType Directory -Path $incoming|Out-Null;` +
      `Set-Content -LiteralPath $owner -Value ${ownerValues}`;
    const finalize =
      `$ErrorActionPreference='Stop';$incoming=${incoming};$final=${final};$archive=${archive};` +
      `tar.exe -xf $archive -C $incoming;if($LASTEXITCODE -ne 0){throw 'tar extraction failed'};` +
      `Remove-Item -LiteralPath $archive;Move-Item -LiteralPath $incoming -Destination $final`;
    return {
      hostId: profile.hostId,
      endpoint: profile.endpoint,
      campaignId: manifest.campaignId,
      finalPath,
      incomingPath,
      manifestSha256,
      probeCommand: ["ssh", profile.endpoint, ...encodedPowerShellCommand(probe)],
      initializeCommand: ["ssh", profile.endpoint, ...encodedPowerShellCommand(initialize)],
      scpDestination: scpRemoteSpec(
        profile.endpoint,
        pathApi.join(incomingPath, "campaign-inputs.tar"),
      ),
      finalizeCommand: ["ssh", profile.endpoint, ...encodedPowerShellCommand(finalize)],
      mutatesExistingPaths: false,
    };
  }

  const checksum = profile.platform === "darwin" ? "shasum -a 256" : "sha256sum";
  const final = quotePosix(finalPath);
  const incoming = quotePosix(incomingPath);
  const parent = quotePosix(pathApi.dirname(finalPath));
  const archive = quotePosix(pathApi.join(incomingPath, "campaign-inputs.tar"));
  const manifestPath = quotePosix(pathApi.join(finalPath, "campaign-manifest.json"));
  const ownerPath = quotePosix(pathApi.join(incomingPath, ".hunk-campaign-owner"));
  return {
    hostId: profile.hostId,
    endpoint: profile.endpoint,
    campaignId: manifest.campaignId,
    finalPath,
    incomingPath,
    manifestSha256,
    probeCommand: [
      "ssh",
      profile.endpoint,
      `if test -f ${manifestPath}; then ${checksum} ${manifestPath} | awk '{print $1}'; elif test -e ${final}; then printf BLOCKED; elif test -f ${ownerPath}; then owner_id=$(sed -n '1p' ${ownerPath}); owner_sha=$(sed -n '2p' ${ownerPath}); if test "$owner_id" = ${quotePosix(manifest.campaignId)} && test "$owner_sha" = ${quotePosix(manifestSha256)}; then printf 'INCOMING:%s' "$owner_sha"; else printf BLOCKED-INCOMING; fi; elif test -e ${incoming}; then printf BLOCKED-INCOMING; else printf MISSING; fi`,
    ],
    initializeCommand: [
      "ssh",
      profile.endpoint,
      `set -eu; test ! -e ${final}; test ! -e ${incoming}; mkdir -p ${parent}; mkdir ${incoming}; printf '%s\\n%s\\n' ${quotePosix(manifest.campaignId)} ${quotePosix(manifestSha256)} > ${ownerPath}`,
    ],
    scpDestination: scpRemoteSpec(
      profile.endpoint,
      pathApi.join(incomingPath, "campaign-inputs.tar"),
    ),
    finalizeCommand: [
      "ssh",
      profile.endpoint,
      `set -eu; tar -xf ${archive} -C ${incoming}; rm ${archive}; mv ${incoming} ${final}`,
    ],
    mutatesExistingPaths: false,
  };
}

/** Execute one local command and retain remote diagnostics. */
function execute(command: string[]): string {
  const proc = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = Buffer.from(proc.stdout).toString("utf8").trim();
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString("utf8").trim() || `${command[0]} failed`);
  }
  return stdout;
}

/** Classify a remote probe, allowing retries only for matching owned incoming content. */
export function classifyStageProbe(
  output: string,
  manifestSha256: string,
): "complete" | "initialize" | "resume" {
  const normalized = output.trim().toLowerCase();
  if (normalized === manifestSha256) return "complete";
  if (normalized === "missing") return "initialize";
  if (normalized === `incoming:${manifestSha256}`) return "resume";
  throw new Error(
    `Remote campaign path is owned by different or unverifiable content: ${normalized}`,
  );
}

/** Stage only frozen manifest/input bytes, never replacing an existing remote path. */
export function stageCampaign(campaignRoot: string, profile: WatchHostProfile): StagePlan {
  const plan = createStagePlan(campaignRoot, profile);
  if (!plan.endpoint || !plan.probeCommand || !plan.initializeCommand || !plan.finalizeCommand) {
    throw new Error(`${profile.hostId} is staged through the pinned GitHub Actions workflow`);
  }
  const action = classifyStageProbe(execute(plan.probeCommand), plan.manifestSha256);
  if (action === "complete") return plan;

  const temporary = mkdtempSync(join(tmpdir(), "hunk-watch-stage-"));
  const archive = join(temporary, "campaign-inputs.tar");
  try {
    execute([
      "tar",
      "-cf",
      archive,
      "-C",
      campaignRoot,
      "campaign-manifest.json",
      "inputs",
      "report.md",
    ]);
    if (action === "initialize") execute(plan.initializeCommand);
    execute(["scp", archive, plan.scpDestination!]);
    execute(plan.finalizeCommand);
    const staged = execute(plan.probeCommand).toLowerCase();
    if (staged !== plan.manifestSha256)
      throw new Error("Remote manifest checksum failed after staging");
    return plan;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function cliOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  try {
    const campaignRoot = cliOption(process.argv, "--campaign-root");
    const hostId = cliOption(process.argv, "--host-id") as WatchHostId | undefined;
    if (!campaignRoot || !hostId || !WATCH_HOST_IDS.includes(hostId)) {
      throw new Error("Usage: stage.ts --campaign-root <path> --host-id <id> [--dry-run]");
    }
    const profile = WATCH_HOST_PROFILES[hostId];
    const plan = process.argv.includes("--dry-run")
      ? createStagePlan(campaignRoot, profile)
      : stageCampaign(campaignRoot, profile);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
