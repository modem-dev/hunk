import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  campaignIdFor,
  campaignLayout,
  verifyCampaignInputs,
  type CampaignManifest,
} from "./campaign";
import { createFrozenRef, freezeCampaign, verifyFrozenBundle } from "./freeze";
import { preparePreflightCampaign } from "./prepare-preflight";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Campaign Test",
  GIT_AUTHOR_EMAIL: "campaign@example.invalid",
  GIT_COMMITTER_NAME: "Campaign Test",
  GIT_COMMITTER_EMAIL: "campaign@example.invalid",
};
let roots: string[] = [];

/** Run deterministic Git commands for campaign fixtures. */
function testGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString("utf8"));
  return Buffer.from(proc.stdout).toString("utf8").trim();
}

/** Create minimal checksum-valid fixture artifacts for freeze integration tests. */
function createFixtureArtifacts(
  root: string,
  sourceSha: string,
  label: "little repo" | "big repo",
) {
  mkdirSync(root, { recursive: true });
  const files = {
    "fixture.bundle": "fixture bundle bytes\n",
    "ignored-tree.jsonl.gz": "ignored bytes\n",
    "fixture-manifest.json": `${JSON.stringify({ schemaVersion: 1, label, sourceSha })}\n`,
    "fixture-summary.md": `# ${label}\n`,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  writeFileSync(
    join(root, "checksums.sha256"),
    Object.keys(files)
      .sort()
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(join(root, name)))
            .digest("hex")}  ${name}`,
      )
      .join("\n") + "\n",
  );
}

/** Create base/candidate/harness commits plus matching remote-tracking refs. */
function createSourceRepository() {
  const root = mkdtempSync(join(tmpdir(), "hunk-watch-freeze-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  testGit(repo, ["init", "--quiet", "--initial-branch=harness"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  testGit(repo, ["add", "."]);
  testGit(repo, ["commit", "--quiet", "-m", "base"]);
  const baseSha = testGit(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "tracked.txt"), "candidate\n");
  testGit(repo, ["commit", "--quiet", "-am", "candidate"]);
  const candidateSha = testGit(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "harness.txt"), "harness\n");
  testGit(repo, ["add", "."]);
  testGit(repo, ["commit", "--quiet", "-m", "harness"]);
  const harnessSha = testGit(repo, ["rev-parse", "HEAD"]);
  testGit(repo, ["update-ref", "refs/remotes/origin/main", baseSha]);
  testGit(repo, ["update-ref", "refs/remotes/origin/elucid/file-watch", candidateSha]);
  writeFileSync(join(repo, "untracked-local.txt"), "must not transfer\n");
  return { root, repo, baseSha, candidateSha, harnessSha };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("watch campaign freeze", () => {
  test("uses deterministic layout and bundles exact immutable refs", () => {
    const source = createSourceRepository();
    const modemSha = "d".repeat(40);
    const little = join(source.root, "little");
    const big = join(source.root, "big");
    createFixtureArtifacts(little, source.candidateSha, "little repo");
    createFixtureArtifacts(big, modemSha, "big repo");
    const now = new Date("2026-07-14T16:30:45.123Z");
    const campaignId = campaignIdFor(now, source.baseSha, source.candidateSha);
    expect(campaignId).toBe(
      `watch-20260714T163045Z-b${source.baseSha.slice(0, 8)}-h${source.candidateSha.slice(0, 8)}`,
    );

    const manifest = freezeCampaign({
      repoDir: source.repo,
      campaignsDir: join(source.root, "campaigns"),
      littleFixtureArtifactsDir: little,
      bigFixtureArtifactsDir: big,
      modemFixtureSourceSha: modemSha,
      now,
      hostname: "curie.local",
      fetchOrigin: false,
    });
    const layout = campaignLayout(join(source.root, "campaigns"), campaignId);
    expect(verifyCampaignInputs(layout.root)).toEqual(manifest);
    expect(manifest.preflightOnly).toBe(false);
    expect(manifest.revisions.harness.sourceSha).toBe(source.harnessSha);
    expect(manifest.untrackedPathsExcluded).toEqual(["untracked-local.txt"]);
    expect(existsSync(join(layout.fixtures["little-repo"], "fixture.bundle"))).toBe(true);
    expect(readFileSync(layout.bundle).toString("latin1")).not.toContain("must not transfer");
    verifyFrozenBundle(source.repo, layout.bundle, {
      [manifest.bundleRefs.base]: source.baseSha,
      [manifest.bundleRefs.candidate]: source.candidateSha,
      [manifest.bundleRefs.harness]: source.harnessSha,
      [manifest.bundleRefs.littleFixtureSource]: source.candidateSha,
    });
    expect(() =>
      freezeCampaign({
        repoDir: source.repo,
        campaignsDir: join(source.root, "campaigns"),
        littleFixtureArtifactsDir: little,
        bigFixtureArtifactsDir: big,
        modemFixtureSourceSha: modemSha,
        now,
        hostname: "curie.local",
        fetchOrigin: false,
      }),
    ).toThrow(/already exists|already frozen/);
  });

  test("refuses dirty tracked state, mismatched frozen refs, and modified checksums", () => {
    const source = createSourceRepository();
    writeFileSync(join(source.repo, "tracked.txt"), "dirty\n");
    expect(() =>
      freezeCampaign({
        repoDir: source.repo,
        campaignsDir: join(source.root, "campaigns"),
        littleFixtureArtifactsDir: join(source.root, "missing"),
        bigFixtureArtifactsDir: join(source.root, "missing"),
        modemFixtureSourceSha: "d".repeat(40),
        hostname: "curie.local",
        fetchOrigin: false,
      }),
    ).toThrow("clean tracked");
    testGit(source.repo, ["checkout", "--", "tracked.txt"]);
    createFrozenRef(source.repo, "refs/hunk-benchmark/test/base", source.baseSha);
    expect(() =>
      createFrozenRef(source.repo, "refs/hunk-benchmark/test/base", source.candidateSha),
    ).toThrow("mismatch");
  });
});

describe("watch preflight campaign preparation", () => {
  test("creates checksum-valid preflight-only inputs from explicit refs", () => {
    const source = createSourceRepository();
    const manifest = preparePreflightCampaign({
      repoDir: source.repo,
      campaignsDir: join(source.root, "preflights"),
      baseRef: source.baseSha,
      candidateRef: source.candidateSha,
      now: new Date("2026-07-14T18:00:00Z"),
    });
    const layout = campaignLayout(join(source.root, "preflights"), manifest.campaignId);
    expect(manifest.preflightOnly).toBe(true);
    expect(verifyCampaignInputs(layout.root)).toEqual(manifest);
    expect(testGit(source.repo, ["show-ref", "--heads"])).not.toContain(manifest.campaignId);
  }, 20_000);
});

describe("watch campaign input validation", () => {
  test("rejects checksum mutation after freeze", () => {
    const source = createSourceRepository();
    const modemSha = "e".repeat(40);
    const little = join(source.root, "little");
    const big = join(source.root, "big");
    createFixtureArtifacts(little, source.candidateSha, "little repo");
    createFixtureArtifacts(big, modemSha, "big repo");
    const manifest: CampaignManifest = freezeCampaign({
      repoDir: source.repo,
      campaignsDir: join(source.root, "campaigns"),
      littleFixtureArtifactsDir: little,
      bigFixtureArtifactsDir: big,
      modemFixtureSourceSha: modemSha,
      now: new Date("2026-07-14T17:00:00Z"),
      hostname: "curie.local",
      fetchOrigin: false,
    });
    const layout = campaignLayout(join(source.root, "campaigns"), manifest.campaignId);
    writeFileSync(join(layout.inputs, "fixtures", "big-repo", "fixture-summary.md"), "changed\n");
    expect(() => verifyCampaignInputs(layout.root)).toThrow("checksum mismatch");
  });
});
