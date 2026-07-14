#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { join, resolve } from "node:path";
import {
  WATCH_HOST_IDS,
  campaignFileSha256,
  campaignIdFor,
  campaignLayout,
  verifyCampaignInputs,
  writeCampaignChecksums,
  writeCampaignJson,
  type CampaignManifest,
} from "./campaign";
import { readFixtureManifest, verifyFixtureArtifacts } from "./fixture";
import { WATCH_PROTOCOL_VERSION } from "./schema";

const BASE_SOURCE_REF = "origin/main" as const;
const CANDIDATE_SOURCE_REF = "origin/elucid/file-watch" as const;

export interface FreezeCampaignOptions {
  repoDir: string;
  campaignsDir: string;
  littleFixtureArtifactsDir: string;
  bigFixtureArtifactsDir: string;
  modemFixtureSourceSha: string;
  now?: Date;
  hostname?: string;
  fetchOrigin?: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run Git with prompts and ambient configuration disabled. */
function runGit(repoDir: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = {
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
  if (proc.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result;
}

/** Resolve one ref to an exact commit object ID. */
function resolveCommit(repoDir: string, ref: string): string {
  return runGit(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`])
    .stdout.trim()
    .toLowerCase();
}

/** Refuse to create or alter a campaign ref that was frozen before this invocation. */
export function createFrozenRef(repoDir: string, ref: string, sha: string): void {
  const existing = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (existing.exitCode === 0) {
    const existingSha = Buffer.from(existing.stdout).toString("utf8").trim();
    throw new Error(
      existingSha.toLowerCase() === sha.toLowerCase()
        ? `Campaign ref is already frozen: ${ref}`
        : `Campaign ref mismatch for ${ref}: ${existingSha} != ${sha}`,
    );
  }
  runGit(repoDir, ["update-ref", ref, sha, ""]);
}

/** Verify that a bundle advertises every frozen ref at its exact SHA. */
export function verifyFrozenBundle(
  repoDir: string,
  bundlePath: string,
  expected: Readonly<Record<string, string>>,
): void {
  const heads = new Map(
    runGit(repoDir, ["bundle", "list-heads", bundlePath])
      .stdout.trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/, 2);
        return [ref!, sha!.toLowerCase()];
      }),
  );
  for (const [ref, sha] of Object.entries(expected)) {
    if (heads.get(ref) !== sha.toLowerCase()) {
      throw new Error(`Bundle ref mismatch for ${ref}`);
    }
  }
}

/** Freeze exact remote revisions and portable fixture inputs into one immutable campaign. */
export function freezeCampaign(options: FreezeCampaignOptions): CampaignManifest {
  const repoDir = resolve(options.repoDir);
  const freezeHost = (options.hostname ?? systemHostname()).split(".")[0]?.toLowerCase();
  if (freezeHost !== "curie" && freezeHost !== "currie") {
    throw new Error("Watch campaigns may only be frozen from curie");
  }
  if (options.fetchOrigin !== false) runGit(repoDir, ["fetch", "origin"]);
  const trackedStatus = runGit(repoDir, ["status", "--porcelain", "--untracked-files=no"]).stdout;
  if (trackedStatus.trim()) throw new Error("Freeze requires a clean tracked working tree");

  const baseSha = resolveCommit(repoDir, BASE_SOURCE_REF);
  const candidateSha = resolveCommit(repoDir, CANDIDATE_SOURCE_REF);
  const harnessSha = resolveCommit(repoDir, "HEAD");
  const now = options.now ?? new Date();
  const campaignId = campaignIdFor(now, baseSha, candidateSha);
  const finalLayout = campaignLayout(options.campaignsDir, campaignId);
  if (existsSync(finalLayout.root)) throw new Error(`Campaign already exists: ${campaignId}`);

  verifyFixtureArtifacts(options.littleFixtureArtifactsDir);
  verifyFixtureArtifacts(options.bigFixtureArtifactsDir);
  const littleFixture = readFixtureManifest(options.littleFixtureArtifactsDir);
  const bigFixture = readFixtureManifest(options.bigFixtureArtifactsDir);
  const modemFixtureSourceSha = options.modemFixtureSourceSha.toLowerCase();
  if (bigFixture.sourceSha !== modemFixtureSourceSha) {
    throw new Error("Big fixture source SHA does not match the explicitly frozen modem SHA");
  }
  // The little fixture comes from Hunk and must remain recoverable from the transferred bundle.
  const littleFixtureSourceSha = resolveCommit(repoDir, littleFixture.sourceSha);
  if (littleFixtureSourceSha !== littleFixture.sourceSha.toLowerCase()) {
    throw new Error("Little fixture source does not resolve to its exact manifest SHA");
  }

  const untrackedPathsExcluded = runGit(repoDir, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const refRoot = `refs/hunk-benchmark/${campaignId}`;
  const bundleRefs = {
    base: `${refRoot}/base`,
    candidate: `${refRoot}/candidate`,
    harness: `${refRoot}/harness`,
    littleFixtureSource: `${refRoot}/fixture-little-source`,
  };
  const refsByName = {
    [bundleRefs.base]: baseSha,
    [bundleRefs.candidate]: candidateSha,
    [bundleRefs.harness]: harnessSha,
    [bundleRefs.littleFixtureSource]: littleFixtureSourceSha,
  };
  for (const ref of Object.keys(refsByName)) {
    const probe = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
      cwd: repoDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.exitCode === 0) throw new Error(`Campaign ref is already frozen: ${ref}`);
  }

  mkdirSync(resolve(options.campaignsDir), { recursive: true });
  const temporaryRoot = mkdtempSync(join(resolve(options.campaignsDir), `.${campaignId}-`));
  const tempInputs = join(temporaryRoot, "inputs");
  const tempBundle = join(tempInputs, "hunk.bundle");
  const createdRefs: string[] = [];
  let published = false;
  try {
    mkdirSync(join(tempInputs, "fixtures"), { recursive: true });
    cpSync(options.littleFixtureArtifactsDir, join(tempInputs, "fixtures", "little-repo"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    cpSync(options.bigFixtureArtifactsDir, join(tempInputs, "fixtures", "big-repo"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    for (const [ref, sha] of Object.entries(refsByName)) {
      createFrozenRef(repoDir, ref, sha);
      createdRefs.push(ref);
    }
    runGit(repoDir, ["bundle", "create", tempBundle, ...Object.keys(refsByName)]);
    verifyFrozenBundle(repoDir, tempBundle, refsByName);
    writeCampaignChecksums(tempInputs);

    const manifest: CampaignManifest = {
      schemaVersion: 1,
      protocolVersion: WATCH_PROTOCOL_VERSION,
      campaignId,
      frozenAt: now.toISOString(),
      orderSeed: campaignId,
      revisions: {
        base: { sourceSha: baseSha, sourceRef: BASE_SOURCE_REF },
        candidate: { sourceSha: candidateSha, sourceRef: CANDIDATE_SOURCE_REF },
        harness: { sourceSha: harnessSha },
      },
      bundleRefs,
      fixtures: {
        "little-repo": {
          sourceSha: littleFixture.sourceSha,
          manifestSha256: campaignFileSha256(
            join(tempInputs, "fixtures", "little-repo", "fixture-manifest.json"),
          ),
          inputPath: "inputs/fixtures/little-repo",
        },
        "big-repo": {
          sourceSha: bigFixture.sourceSha,
          manifestSha256: campaignFileSha256(
            join(tempInputs, "fixtures", "big-repo", "fixture-manifest.json"),
          ),
          inputPath: "inputs/fixtures/big-repo",
        },
      },
      modemFixtureSourceSha,
      untrackedPathsExcluded,
      inputChecksumsPath: "inputs/SHA256SUMS",
      hostIds: [...WATCH_HOST_IDS],
    };
    writeCampaignJson(join(temporaryRoot, "campaign-manifest.json"), manifest);
    for (const hostId of WATCH_HOST_IDS) {
      mkdirSync(join(temporaryRoot, "hosts", hostId, "provenance"), { recursive: true });
      mkdirSync(join(temporaryRoot, "raw", hostId), { recursive: true });
    }
    mkdirSync(join(temporaryRoot, "summaries"), { recursive: true });
    writeFileSync(join(temporaryRoot, "report.md"), `# Watch benchmark — ${campaignId}\n`);

    renameSync(temporaryRoot, finalLayout.root);
    published = true;
    verifyCampaignInputs(finalLayout.root);
    return manifest;
  } catch (error) {
    if (published) rmSync(finalLayout.root, { recursive: true, force: true });
    else rmSync(temporaryRoot, { recursive: true, force: true });
    for (const ref of createdRefs.reverse()) {
      try {
        runGit(repoDir, ["update-ref", "-d", ref, refsByName[ref]!]);
      } catch {
        // Preserve a ref if another process changed it rather than deleting mutable evidence.
      }
    }
    throw error;
  }
}

/** Read one required CLI option. */
function cliOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function main(args: string[]): void {
  const manifest = freezeCampaign({
    repoDir: cliOption(args, "--repo"),
    campaignsDir: cliOption(args, "--campaigns-dir"),
    littleFixtureArtifactsDir: cliOption(args, "--little-fixture"),
    bigFixtureArtifactsDir: cliOption(args, "--big-fixture"),
    modemFixtureSourceSha: cliOption(args, "--modem-source-sha"),
  });
  process.stdout.write(`${manifest.campaignId}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
