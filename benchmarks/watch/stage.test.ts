import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { campaignFileSha256, writeCampaignChecksums, writeCampaignJson } from "./campaign";
import type { WatchHostProfile } from "./host-preflight";
import {
  classifyStageProbe,
  createStagePlan,
  encodedPowerShellCommand,
  quotePowerShell,
  scpRemoteSpec,
} from "./stage";

let roots: string[] = [];

/** Create one minimal checksum-valid frozen campaign for transfer-plan tests. */
function createTestCampaign(): string {
  const campaigns = mkdtempSync(join(tmpdir(), "hunk-watch-stage-test-"));
  roots.push(campaigns);
  const id = `watch-20260714T180000Z-b${"a".repeat(8)}-h${"b".repeat(8)}`;
  const root = join(campaigns, id);
  for (const fixture of ["little-repo", "big-repo"]) {
    const directory = join(root, "inputs", "fixtures", fixture);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "fixture-manifest.json"), `${fixture}\n`);
  }
  writeFileSync(join(root, "inputs", "hunk.bundle"), "bundle\n");
  writeCampaignChecksums(join(root, "inputs"));
  const sha = (character: string) => character.repeat(40);
  writeCampaignJson(join(root, "campaign-manifest.json"), {
    schemaVersion: 1,
    protocolVersion: "watch-v1",
    campaignId: id,
    preflightOnly: false,
    frozenAt: "2026-07-14T18:00:00.000Z",
    orderSeed: id,
    revisions: {
      base: { sourceSha: sha("a"), sourceRef: "origin/main" },
      candidate: { sourceSha: sha("b"), sourceRef: "origin/elucid/file-watch" },
      harness: { sourceSha: sha("c") },
    },
    bundleRefs: {
      base: `refs/hunk-benchmark/${id}/base`,
      candidate: `refs/hunk-benchmark/${id}/candidate`,
      harness: `refs/hunk-benchmark/${id}/harness`,
      littleFixtureSource: `refs/hunk-benchmark/${id}/fixture-little-source`,
    },
    fixtures: {
      "little-repo": {
        sourceSha: sha("b"),
        manifestSha256: campaignFileSha256(
          join(root, "inputs", "fixtures", "little-repo", "fixture-manifest.json"),
        ),
        inputPath: "inputs/fixtures/little-repo",
      },
      "big-repo": {
        sourceSha: sha("d"),
        manifestSha256: campaignFileSha256(
          join(root, "inputs", "fixtures", "big-repo", "fixture-manifest.json"),
        ),
        inputPath: "inputs/fixtures/big-repo",
      },
    },
    modemFixtureSourceSha: sha("d"),
    untrackedPathsExcluded: [],
    inputChecksumsPath: "inputs/SHA256SUMS",
    hostIds: [
      "macos-arm64-aarmstrong",
      "linux-x64-sentry-agent",
      "windows-arm64-hunk-windows",
      "windows-x64-gha",
    ],
  });
  writeFileSync(join(root, "report.md"), "# report\n");
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("watch campaign staging", () => {
  test("quotes space-containing Windows paths without script interpolation", () => {
    const campaign = createTestCampaign();
    const profile: WatchHostProfile = {
      hostId: "windows-arm64-hunk-windows",
      endpoint: "hunk@example.invalid",
      platform: "win32",
      arch: "arm64",
      workspace: "C:\\DEV\\Watch Campaign Inputs",
      bunPath: "C:\\Pinned Bun\\bun.exe",
      filesystem: "NTFS",
      notes: [],
    };
    const plan = createStagePlan(campaign, profile);
    expect(plan.finalPath).toContain("Watch Campaign Inputs");
    expect(plan.scpDestination).toContain("C:/DEV/Watch Campaign Inputs/");
    expect(plan.scpDestination).not.toContain("'");
    const encoded = plan.initializeCommand!.at(-1)!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("C:\\DEV\\Watch Campaign Inputs");
    expect(decoded).toContain("Test-Path -LiteralPath");
    expect(plan.mutatesExistingPaths).toBe(false);
  });

  test("resumes only an incoming transfer with the matching ownership digest", () => {
    const digest = "a".repeat(64);
    expect(classifyStageProbe("MISSING", digest)).toBe("initialize");
    expect(classifyStageProbe(`INCOMING:${digest}`, digest)).toBe("resume");
    expect(classifyStageProbe(digest, digest)).toBe("complete");
    expect(() => classifyStageProbe(`INCOMING:${"b".repeat(64)}`, digest)).toThrow(
      "different or unverifiable",
    );
  });

  test("escapes PowerShell literals and keeps SCP destination one argument", () => {
    expect(quotePowerShell("C:\\it's here")).toBe("'C:\\it''s here'");
    expect(encodedPowerShellCommand("Write-Output 'ok'")).toHaveLength(6);
    expect(scpRemoteSpec("user@host", "C:\\A B\\file.tar")).toBe("user@host:C:/A B/file.tar");
  });
});
