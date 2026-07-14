#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { buildFixture } from "./fixture";
import { WATCH_PROTOCOL_VERSION } from "./schema";

interface PreparePreflightOptions {
  repoDir: string;
  campaignsDir: string;
  baseRef: string;
  candidateRef: string;
  now?: Date;
}

/** Run credential-free Git commands while ignoring ambient user configuration. */
function git(repoDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim() || "git failed");
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

/** Build an explicitly non-final tiny campaign from refs already present in one checkout. */
export function preparePreflightCampaign(options: PreparePreflightOptions): CampaignManifest {
  const repoDir = resolve(options.repoDir);
  const baseSha = git(repoDir, [
    "rev-parse",
    "--verify",
    `${options.baseRef}^{commit}`,
  ]).toLowerCase();
  const candidateSha = git(repoDir, [
    "rev-parse",
    "--verify",
    `${options.candidateRef}^{commit}`,
  ]).toLowerCase();
  const harnessSha = git(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
  const now = options.now ?? new Date();
  const campaignId = campaignIdFor(now, baseSha, candidateSha);
  const layout = campaignLayout(options.campaignsDir, campaignId);
  if (existsSync(layout.root)) throw new Error(`Preflight campaign already exists: ${campaignId}`);

  const scratch = mkdtempSync(join(tmpdir(), "hunk-watch-preflight-"));
  const ignoredManifest = join(scratch, "ignored-directories.jsonl");
  writeFileSync(ignoredManifest, "");
  const refRoot = `refs/hunk-benchmark/${campaignId}`;
  const bundleRefs = {
    base: `${refRoot}/base`,
    candidate: `${refRoot}/candidate`,
    harness: `${refRoot}/harness`,
    littleFixtureSource: `${refRoot}/fixture-little-source`,
  };
  const refs = {
    [bundleRefs.base]: baseSha,
    [bundleRefs.candidate]: candidateSha,
    [bundleRefs.harness]: harnessSha,
    [bundleRefs.littleFixtureSource]: candidateSha,
  };

  try {
    mkdirSync(layout.inputs, { recursive: true });
    buildFixture({
      sourceGitPath: repoDir,
      sourceSha: candidateSha,
      ignoredDirectoryManifestPath: ignoredManifest,
      label: "little repo",
      seed: "watch-preflight-v1",
      scale: 1,
      outputDir: layout.fixtures["little-repo"],
    });
    buildFixture({
      sourceGitPath: repoDir,
      sourceSha: candidateSha,
      ignoredDirectoryManifestPath: ignoredManifest,
      label: "big repo",
      seed: "watch-preflight-v1",
      scale: 1,
      outputDir: layout.fixtures["big-repo"],
    });
    for (const [ref, sha] of Object.entries(refs)) git(repoDir, ["update-ref", ref, sha, ""]);
    git(repoDir, ["bundle", "create", layout.bundle, ...Object.keys(refs)]);
    writeCampaignChecksums(layout.inputs);

    const manifest: CampaignManifest = {
      schemaVersion: 1,
      protocolVersion: WATCH_PROTOCOL_VERSION,
      campaignId,
      preflightOnly: true,
      frozenAt: now.toISOString(),
      orderSeed: `${campaignId}-preflight-only`,
      revisions: {
        base: { sourceSha: baseSha, sourceRef: options.baseRef },
        candidate: { sourceSha: candidateSha, sourceRef: options.candidateRef },
        harness: { sourceSha: harnessSha },
      },
      bundleRefs,
      fixtures: {
        "little-repo": {
          sourceSha: candidateSha,
          manifestSha256: campaignFileSha256(
            join(layout.fixtures["little-repo"], "fixture-manifest.json"),
          ),
          inputPath: "inputs/fixtures/little-repo",
        },
        "big-repo": {
          sourceSha: candidateSha,
          manifestSha256: campaignFileSha256(
            join(layout.fixtures["big-repo"], "fixture-manifest.json"),
          ),
          inputPath: "inputs/fixtures/big-repo",
        },
      },
      modemFixtureSourceSha: candidateSha,
      untrackedPathsExcluded: [],
      inputChecksumsPath: "inputs/SHA256SUMS",
      hostIds: [...WATCH_HOST_IDS],
    };
    writeCampaignJson(layout.manifest, manifest);
    mkdirSync(layout.hosts, { recursive: true });
    mkdirSync(layout.raw, { recursive: true });
    mkdirSync(layout.summaries, { recursive: true });
    writeFileSync(
      layout.report,
      `# Watch benchmark preflight — ${campaignId}\n\nPRELIMINARY PREFLIGHT ONLY.\n`,
    );
    verifyCampaignInputs(layout.root);
    return manifest;
  } catch (error) {
    rmSync(layout.root, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [ref, sha] of Object.entries(refs)) {
      try {
        git(repoDir, ["update-ref", "-d", ref, sha]);
      } catch {
        // Preserve a ref that was changed concurrently rather than deleting unrelated state.
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Read one required command-line option. */
function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (import.meta.main) {
  try {
    const manifest = preparePreflightCampaign({
      repoDir: option(process.argv, "--repo"),
      campaignsDir: option(process.argv, "--campaigns-dir"),
      baseRef: option(process.argv, "--base-ref"),
      candidateRef: option(process.argv, "--candidate-ref"),
    });
    process.stdout.write(`${manifest.campaignId}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
