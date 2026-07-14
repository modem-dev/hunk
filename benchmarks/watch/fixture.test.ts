import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  atomicRenameTrackedWrite,
  authoritativeGitSignature,
  buildFixture,
  createPortableIgnoredTree,
  ordinaryTrackedWrite,
  readFixtureManifest,
  reconstructFixture,
  relevantUntrackedCreation,
  resetFixtureState,
  startupLaunchOrder,
  validatePortableRelativePath,
  verifyFixtureArtifacts,
} from "./fixture";

const FIXED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture Source",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture Source",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
};

let tempRoots: string[] = [];

/** Run Git for a test fixture with deterministic identity and configuration. */
function testGit(cwd: string, args: string[], input?: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: FIXED_GIT_ENV,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString("utf8"));
  return Buffer.from(proc.stdout).toString("utf8");
}

/** Create a deterministic source bundle plus ignored-path-only input manifest. */
function createTestInputs() {
  const root = mkdtempSync(join(tmpdir(), "hunk-watch-fixture-test-"));
  tempRoots.push(root);
  const source = join(root, "source");
  mkdirSync(join(source, "src", "nested"), { recursive: true });
  testGit(source, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(source, "README.md"), "portable source snapshot\n");
  writeFileSync(join(source, ".gitignore"), "private-ignored/\n");
  writeFileSync(join(source, "src", "nested", "file.ts"), "export const value = 1;\n");
  testGit(source, ["add", "."]);

  // Add a symlink blob directly so this policy test does not require Windows symlink privileges.
  const linkBlob = testGit(source, ["hash-object", "-w", "--stdin"], "README.md").trim();
  testGit(source, ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},readme-link`]);
  testGit(source, ["commit", "--quiet", "-m", "source snapshot"]);
  const sourceSha = testGit(source, ["rev-parse", "HEAD"]).trim();
  testGit(source, [
    "remote",
    "add",
    "origin",
    "https://user:source-secret@example.invalid/private.git",
  ]);

  mkdirSync(join(source, "private-ignored", "deep"), { recursive: true });
  writeFileSync(join(source, "private-ignored", "deep", "secret.txt"), "ignored-source-secret\n");
  writeFileSync(join(source, "unrelated-untracked.txt"), "unrelated-source-secret\n");

  const sourceBundle = join(root, "source.bundle");
  testGit(source, ["bundle", "create", sourceBundle, "refs/heads/main"]);
  const ignoredManifest = join(root, "ignored-source.jsonl");
  writeFileSync(
    ignoredManifest,
    [JSON.stringify({ path: "node_modules/pkg/cache" }), JSON.stringify("CON/aux?. ")].join("\n") +
      "\n",
  );
  return { root, sourceBundle, sourceSha, ignoredManifest };
}

/** Read all artifact bytes by stable filename for determinism assertions. */
function readArtifacts(directory: string): Map<string, Buffer> {
  return new Map(
    readdirSync(directory)
      .sort()
      .map((filename) => [filename, readFileSync(join(directory, filename))]),
  );
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

describe("watch benchmark portable paths", () => {
  test("rejects Windows edge cases and bounded-length violations", () => {
    for (const path of [
      "CON/file",
      "dir/NUL.txt",
      "dir/trailing. ",
      "dir/bad?.txt",
      "../escape",
      `dir/${"a".repeat(81)}`,
      `root/${Array.from({ length: 30 }, () => "component").join("/")}`,
    ]) {
      expect(() => validatePortableRelativePath(path)).toThrow();
    }
    expect(() => validatePortableRelativePath("portable/path-01")).not.toThrow();
  });

  test("sanitizes names while preserving parent shape and stable order", () => {
    const paths = ["CON", "CON/child?", "sibling."];
    const first = createPortableIgnoredTree(paths, "seed", 1);
    const second = createPortableIgnoredTree([...paths].reverse(), "seed", 1);

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    for (const entry of first) {
      expect(() => validatePortableRelativePath(entry.path)).not.toThrow();
      expect(entry.path).not.toContain("CON");
      expect(entry.path).not.toContain("child");
    }
    const nested = first.find((entry) => entry.path.split("/").length === 3)!;
    expect(first.some((entry) => nested.path.startsWith(`${entry.path}/`))).toBe(true);
  });
});

describe("watch benchmark campaign order", () => {
  test("selects a balanced startup sequence or its mirror from the stored seed", () => {
    const order = startupLaunchOrder("campaign-seed");
    const sequence = order.map((revision) => (revision === "base" ? "A" : "B")).join("");

    expect(["ABBABAABAB", "BAABABBABA"]).toContain(sequence);
    expect(order.filter((revision) => revision === "base")).toHaveLength(5);
    expect(order.filter((revision) => revision === "candidate")).toHaveLength(5);
    expect(startupLaunchOrder("campaign-seed")).toEqual(order);
    expect(() => startupLaunchOrder("")).toThrow();
  });
});

describe("watch benchmark fixture artifacts", () => {
  test("builds deterministically, reconstructs exact counts, and restores every mutation", async () => {
    const inputs = createTestInputs();
    const artifactsA = join(inputs.root, "artifacts-a");
    const artifactsB = join(inputs.root, "artifacts-b");
    const common = {
      sourceGitPath: inputs.sourceBundle,
      sourceSha: inputs.sourceSha,
      ignoredDirectoryManifestPath: inputs.ignoredManifest,
      label: "little repo" as const,
      seed: "watch-v1",
      scale: 1,
    };

    const manifestA = buildFixture({ ...common, outputDir: artifactsA });
    const manifestB = buildFixture({ ...common, outputDir: artifactsB });
    expect(readArtifacts(artifactsA)).toEqual(readArtifacts(artifactsB));
    expect(manifestA).toEqual(manifestB);
    expect(manifestA.counts).toEqual({
      totalSubdirectoryCount: 9,
      ignoredSubdirectoryCount: 6,
      relevantSubdirectoryCount: 3,
      trackedFileCount: 5,
      untrackedFileCount: 1,
      symlinkCount: 1,
      symlinkPolicy: "materialize-as-plain-files",
      maximumDepth: 4,
    });
    verifyFixtureArtifacts(artifactsA);
    expect(readFixtureManifest(artifactsA)).toEqual(manifestA);
    expect(readFileSync(join(artifactsA, "fixture-summary.md"), "utf8")).toContain(
      "| Total subdirectories | 9 |",
    );

    const artifactBytes = Buffer.concat([...readArtifacts(artifactsA).values()]).toString("latin1");
    for (const secret of [
      "source-secret",
      "ignored-source-secret",
      "unrelated-source-secret",
      "node_modules",
      "aux?",
    ]) {
      expect(artifactBytes).not.toContain(secret);
    }

    const repoDir = join(inputs.root, "reconstructed");
    const reconstructed = reconstructFixture({ artifactsDir: artifactsA, repoDir });
    expect(reconstructed.counts).toEqual(manifestA.counts);
    expect(testGit(repoDir, ["remote"]).trim()).toBe("");
    expect(testGit(repoDir, ["config", "--get", "core.autocrlf"]).trim()).toBe("false");
    expect(testGit(repoDir, ["config", "--get", "core.symlinks"]).trim()).toBe("false");
    expect(lstatSync(join(repoDir, "readme-link")).isFile()).toBe(true);
    expect(readFileSync(join(repoDir, "readme-link"), "utf8")).toBe("README.md");
    expect(existsSync(join(repoDir, ".hunk-benchmark", "existing-untracked.txt"))).toBe(true);

    const standardSignature = authoritativeGitSignature(repoDir);
    for (const mutate of [
      ordinaryTrackedWrite,
      atomicRenameTrackedWrite,
      relevantUntrackedCreation,
    ]) {
      let observedMutatedState = false;
      const evidence = await mutate({ artifactsDir: artifactsA, repoDir }, async (observed) => {
        await Promise.resolve();
        observedMutatedState = authoritativeGitSignature(repoDir) === observed.mutatedSignature;
      });
      expect(observedMutatedState).toBe(true);
      expect(evidence.mutatedSignature).not.toBe(evidence.beforeSignature);
      expect(evidence.restoredSignature).toBe(evidence.beforeSignature);
      expect(authoritativeGitSignature(repoDir)).toBe(standardSignature);
    }

    const prearmedEvidence = await ordinaryTrackedWrite(
      { artifactsDir: artifactsA, repoDir, resetBeforeMutation: false },
      async (observed) => {
        expect(authoritativeGitSignature(repoDir)).toBe(observed.mutatedSignature);
      },
    );
    expect(prearmedEvidence.restoredSignature).toBe(standardSignature);

    writeFileSync(join(repoDir, "unrelated-after-reconstruction.txt"), "remove me\n");
    resetFixtureState({ artifactsDir: artifactsA, repoDir });
    expect(existsSync(join(repoDir, "unrelated-after-reconstruction.txt"))).toBe(false);
    expect(authoritativeGitSignature(repoDir)).toBe(standardSignature);
  });
});
