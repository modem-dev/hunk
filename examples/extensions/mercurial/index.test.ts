import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionVcsDiffInput,
  ExtensionVcsOperations,
  ExtensionVcsShowInput,
} from "hunkdiff/extension";
import mercurialExtension, {
  detectMercurialRepo,
  hasSaplingTreestateRequirement,
  MercurialVcsAdapter,
} from "./index.js";

const tempDirectories: string[] = [];
const operations: ExtensionVcsOperations = MercurialVcsAdapter.operations;
const integrationRequested = process.env.HUNK_RUN_HG_INTEGRATION === "1";
const hgAvailable =
  spawnSync("hg", ["version"], { encoding: "utf8", windowsHide: true }).status === 0;
const runIntegration = integrationRequested && hgAvailable;
const integrationTimeout = 30_000;

/** Create and track a real, normalized temporary directory. */
function createTempDirectory(prefix: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirectories.push(directory);
  return directory;
}

/** Normalize platform-specific root spelling before equality assertions. */
function comparablePath(filePath: string) {
  const canonical = platform() === "win32" ? realpathSync.native(filePath) : realpathSync(filePath);
  return canonical.replace(/\\/g, "/");
}

/** Run the real Mercurial executable for opt-in integration setup. */
function hg(cwd: string, ...args: string[]) {
  const result = spawnSync("hg", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HGPLAIN: "1", HGENCODING: "utf-8" },
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `hg ${args.join(" ")} failed`);
  }
  return result.stdout;
}

/** Initialize a repository with a deterministic test identity. */
function createHgRepository(prefix: string) {
  const repoRoot = createTempDirectory(prefix);
  hg(repoRoot, "init");
  return repoRoot;
}

const workingInput = (overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput => ({
  kind: "vcs",
  staged: false,
  options: {},
  ...overrides,
});

const revisionInput = (overrides: Partial<ExtensionVcsShowInput> = {}): ExtensionVcsShowInput => ({
  kind: "show",
  options: {},
  ...overrides,
});

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("Mercurial extension detection and registration", () => {
  test("walks upward from nested directories", () => {
    const repoRoot = createTempDirectory("hunk-hg-detect-");
    mkdirSync(join(repoRoot, ".hg"));
    const nested = join(repoRoot, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(detectMercurialRepo(nested)).toEqual({ id: "hg", repoRoot });
  });

  test("declines only the exact Sapling treestate requirement", () => {
    const repoRoot = createTempDirectory("hunk-hg-sapling-");
    const hgDirectory = join(repoRoot, ".hg");
    mkdirSync(hgDirectory);
    writeFileSync(join(hgDirectory, "requires"), "revlogv1\ntreestate-extra\n");
    expect(hasSaplingTreestateRequirement(hgDirectory)).toBe(false);
    expect(detectMercurialRepo(repoRoot)).toEqual({ id: "hg", repoRoot });

    writeFileSync(join(hgDirectory, "requires"), "revlogv1\ntreestate\n");
    expect(hasSaplingTreestateRequirement(hgDirectory)).toBe(true);
    expect(detectMercurialRepo(repoRoot)).toBeNull();
  });

  test("returns null without a marker and registers the hg adapter", () => {
    expect(detectMercurialRepo(createTempDirectory("hunk-hg-none-"))).toBeNull();
    let registered: unknown = null;
    mercurialExtension({
      registerVcsAdapter(adapter) {
        registered = adapter;
      },
    } as Parameters<typeof mercurialExtension>[0]);
    expect(registered).toBe(MercurialVcsAdapter);
    expect(MercurialVcsAdapter.id).toBe("hg");
    expect(MercurialVcsAdapter.name).toBe("Mercurial");
    expect(MercurialVcsAdapter.detectionPriority).toBeGreaterThan(0);
    expect(operations["stash-show"]).toBeUndefined();
  });

  test("rejects staged before invoking Mercurial", async () => {
    await expect(
      operations["working-tree-diff"]!.load(workingInput({ staged: true }), {
        cwd: createTempDirectory("hunk-hg-staged-"),
      }),
    ).rejects.toThrow("Mercurial has no staging area");
  });
});

describe.skipIf(!runIntegration)("Mercurial adapter integration", () => {
  test(
    "loads deterministic working-copy patches, unknown files, sources, and poll signatures",
    async () => {
      const repoRoot = createHgRepository("hunk-hg-working-");
      writeFileSync(join(repoRoot, "tracked.txt"), "old\n");
      hg(repoRoot, "add", "tracked.txt");
      hg(repoRoot, "commit", "--user", "Hunk Test", "--message", "initial");
      writeFileSync(join(repoRoot, "tracked.txt"), "new\n");
      writeFileSync(join(repoRoot, "unknown.txt"), "one\n");
      if (platform() !== "win32") {
        writeFileSync(join(repoRoot, ".hg", "watch-target"), "linked one\n");
        symlinkSync(join(".hg", "watch-target"), join(repoRoot, "linked.txt"));
      }
      const nested = join(repoRoot, "nested");
      mkdirSync(nested);

      const input = workingInput();
      const result = await operations["working-tree-diff"]!.load(input, { cwd: nested });
      const repeated = await operations["working-tree-diff"]!.load(input, { cwd: nested });

      expect(comparablePath(result.repoRoot)).toBe(comparablePath(repoRoot));
      expect(result.patchText).toBe(repeated.patchText);
      expect(result.patchText).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(result.patchText).toContain("+new");
      expect(result.untrackedPaths).toEqual(
        platform() === "win32" ? ["unknown.txt"] : ["linked.txt", "unknown.txt"],
      );
      expect(result.readFileSource).toBeDefined();
      const trackedRequest = {
        path: "tracked.txt",
        changeType: "change",
        isUntracked: false,
      } as const;
      expect(await result.readFileSource?.({ ...trackedRequest, side: "old" })).toBe("old\n");
      expect(await result.readFileSource?.({ ...trackedRequest, side: "new" })).toBe("new\n");
      expect(
        await result.readFileSource?.({
          path: "unknown.txt",
          changeType: "new",
          isUntracked: true,
          side: "old",
        }),
      ).toBeNull();

      const operation = operations["working-tree-diff"]!;
      expect(operation.watchPlan?.(input, { cwd: nested })).toEqual({
        coverage: "poll-only",
        targets: [],
      });
      const beforeRewrite = operation.watchSignature?.(input, { cwd: nested });
      writeFileSync(join(repoRoot, "unknown.txt"), "two\n");
      const afterRewrite = operation.watchSignature?.(input, { cwd: nested });
      expect(afterRewrite).not.toBe(beforeRewrite);

      if (platform() !== "win32") {
        expect(
          await result.readFileSource?.({
            path: "linked.txt",
            changeType: "new",
            isUntracked: true,
            side: "new",
          }),
        ).toBe("linked one\n");
        writeFileSync(join(repoRoot, ".hg", "watch-target"), "linked two\n");
        expect(operation.watchSignature?.(input, { cwd: nested })).not.toBe(afterRewrite);
      }
    },
    integrationTimeout,
  );

  test(
    "supports safe path filters, committed ranges, and exact revision sources",
    async () => {
      const repoRoot = createHgRepository("hunk-hg-revisions-");
      writeFileSync(join(repoRoot, "selected.txt"), "first\n");
      writeFileSync(join(repoRoot, "other.txt"), "other one\n");
      hg(repoRoot, "add", "selected.txt", "other.txt");
      hg(repoRoot, "commit", "--user", "Hunk Test", "--message", "first");
      writeFileSync(join(repoRoot, "selected.txt"), "second\n");
      writeFileSync(join(repoRoot, "other.txt"), "other two\n");
      hg(repoRoot, "commit", "--user", "Hunk Test", "--message", "second");
      writeFileSync(join(repoRoot, "unknown.txt"), "unknown\n");

      const filtered = await operations["revision-show"]!.load(
        revisionInput({ ref: ".", pathspecs: ["selected.txt"] }),
        { cwd: repoRoot },
      );
      expect(filtered.patchText).toContain("selected.txt");
      expect(filtered.patchText).not.toContain("other.txt");
      const sourceRequest = {
        path: "selected.txt",
        changeType: "change",
        isUntracked: false,
      } as const;
      expect(await filtered.readFileSource?.({ ...sourceRequest, side: "old" })).toBe("first\n");
      expect(await filtered.readFileSource?.({ ...sourceRequest, side: "new" })).toBe("second\n");

      const pair = await operations["working-tree-diff"]!.load(workingInput({ range: "0:1" }), {
        cwd: repoRoot,
      });
      expect(pair.patchText).toContain("+second");
      expect(pair.untrackedPaths).toEqual([]);
      expect(await pair.readFileSource?.({ ...sourceRequest, side: "old" })).toBe("first\n");
      expect(await pair.readFileSource?.({ ...sourceRequest, side: "new" })).toBe("second\n");
      expect(
        await pair.readFileSource?.({
          path: "selected.txt",
          changeType: "new",
          isUntracked: false,
          side: "old",
        }),
      ).toBeNull();
      expect(
        await pair.readFileSource?.({
          path: "selected.txt",
          changeType: "deleted",
          isUntracked: false,
          side: "new",
        }),
      ).toBeNull();

      hg(repoRoot, "rename", "selected.txt", "renamed.txt");
      hg(repoRoot, "commit", "--user", "Hunk Test", "--message", "rename");
      const renamed = await operations["revision-show"]!.load(revisionInput(), { cwd: repoRoot });
      const renameRequest = {
        path: "renamed.txt",
        previousPath: "selected.txt",
        changeType: "rename-pure",
        isUntracked: false,
      } as const;
      expect(await renamed.readFileSource?.({ ...renameRequest, side: "old" })).toBe("second\n");
      expect(await renamed.readFileSource?.({ ...renameRequest, side: "new" })).toBe("second\n");
    },
    integrationTimeout,
  );

  test(
    "translates invalid revisions from the real executable",
    async () => {
      const repoRoot = createHgRepository("hunk-hg-invalid-");
      await expect(
        operations["revision-show"]!.load(revisionInput({ ref: "does-not-exist" }), {
          cwd: repoRoot,
        }),
      ).rejects.toThrow("could not resolve Mercurial revision `does-not-exist`");
    },
    integrationTimeout,
  );
});
