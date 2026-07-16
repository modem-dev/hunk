import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUnsupportedVcsOperationError,
  createVcsWatchPlan,
  detectVcs,
  findVcsRepoRootCandidate,
  getVcsAdapter,
  isVcsId,
  loadVcsReview,
  operationFromInput,
  vcsAdapters,
} from ".";
import type { VcsShowCommandInput, VcsStashShowCommandInput, VcsDiffCommandInput } from "../types";
import type { VcsAdapter } from "./types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("VCS adapter registry", () => {
  test("registers Git, Jujutsu, and Sapling operation maps", () => {
    expect(vcsAdapters.map((adapter) => adapter.id)).toEqual(["jj", "sl", "git"]);
    expect(getVcsAdapter("git").operations["working-tree-diff"]).toBeDefined();
    expect(getVcsAdapter("git").operations["revision-show"]).toBeDefined();
    expect(getVcsAdapter("git").operations["stash-show"]).toBeDefined();
    expect(getVcsAdapter("jj").operations["working-tree-diff"]).toBeDefined();
    expect(getVcsAdapter("jj").operations["revision-show"]).toBeDefined();
    expect(getVcsAdapter("jj").operations["stash-show"]).toBeUndefined();
    expect(getVcsAdapter("sl").operations["working-tree-diff"]).toBeDefined();
    expect(getVcsAdapter("sl").operations["revision-show"]).toBeDefined();
    expect(getVcsAdapter("sl").operations["stash-show"]).toBeUndefined();
  });

  test("validates VCS ids from the registered adapter list", () => {
    expect(isVcsId("git")).toBe(true);
    expect(isVcsId("jj")).toBe(true);
    expect(isVcsId("sl")).toBe(true);
    expect(isVcsId("hg")).toBe(false);
  });

  test("throws for an unregistered VCS id", () => {
    expect(() => getVcsAdapter("hg" as VcsAdapter["id"])).toThrow("Unsupported VCS: hg");
  });

  test("finds repo root candidates through adapter detection instead of id-derived markers", () => {
    const repo = createTempDir("hunk-vcs-custom-marker-");
    const nested = join(repo, "src", "nested");
    mkdirSync(join(repo, ".custom"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    const adapter: VcsAdapter = {
      id: "git",
      name: "Custom marker test adapter",
      detect(cwd) {
        return cwd === repo ? { id: "git", repoRoot: repo } : null;
      },
      operations: {},
    };

    vcsAdapters.unshift(adapter);
    try {
      expect(findVcsRepoRootCandidate(nested)).toBe(repo);
    } finally {
      expect(vcsAdapters.shift()).toBe(adapter);
    }
  });

  test("detects repository roots by registered adapter priority", () => {
    const repo = createTempDir("hunk-vcs-registry-");
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));

    expect(detectVcs(nested)).toEqual({ id: "git", repoRoot: repo });
    expect(findVcsRepoRootCandidate(nested)).toBe(repo);
  });

  test("prefers the nearest checkout over a parent repository with higher adapter priority", () => {
    const parent = createTempDir("hunk-vcs-parent-jj-");
    const repo = join(parent, "project");
    const nested = join(repo, "src", "nested");
    mkdirSync(join(parent, ".jj"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(detectVcs(nested)).toEqual({ id: "git", repoRoot: repo });
    expect(findVcsRepoRootCandidate(nested)).toBe(repo);
  });

  test("maps CLI inputs to neutral review operations", () => {
    const diffInput = {
      kind: "vcs",
      staged: false,
      options: { vcs: "git" },
    } satisfies VcsDiffCommandInput;
    const showInput = {
      kind: "show",
      ref: "HEAD",
      options: { vcs: "git" },
    } satisfies VcsShowCommandInput;
    const stashInput = {
      kind: "stash-show",
      options: { vcs: "git" },
    } satisfies VcsStashShowCommandInput;

    expect(operationFromInput(diffInput)).toEqual({ kind: "working-tree-diff", input: diffInput });
    expect(operationFromInput(showInput)).toEqual({ kind: "revision-show", input: showInput });
    expect(operationFromInput(stashInput)).toEqual({ kind: "stash-show", input: stashInput });
  });

  test("creates friendly errors for unsupported adapter operations", async () => {
    const adapter = getVcsAdapter("jj");
    const input = {
      kind: "stash-show",
      options: { vcs: "jj" },
    } satisfies VcsStashShowCommandInput;

    expect(
      createUnsupportedVcsOperationError(adapter, operationFromInput(input).kind).message,
    ).toBe("`hunk stash show` requires Git VCS mode.");
    await expect(
      loadVcsReview(adapter, operationFromInput(input), { cwd: process.cwd() }),
    ).rejects.toThrow("`hunk stash show` requires Git VCS mode.");
  });

  test("dispatches watch plans and leaves adapters without one poll-only", () => {
    const input = {
      kind: "vcs",
      staged: false,
      options: { vcs: "custom" },
    } satisfies VcsDiffCommandInput;
    const target = {
      kind: "directory-tree" as const,
      directory: "/repo",
      ignoredRoots: [],
      sources: ["worktree" as const],
    };
    const adapter = {
      id: "custom",
      name: "Custom VCS",
      detect: () => null,
      operations: {
        "working-tree-diff": {
          load: async () => ({
            repoRoot: "/repo",
            sourceLabel: "/repo",
            title: "x",
            patchText: "",
          }),
          watchPlan: () => ({ coverage: "hybrid" as const, targets: [target] }),
        },
      },
    } satisfies VcsAdapter;

    expect(createVcsWatchPlan(adapter, operationFromInput(input), { cwd: "/repo" })).toEqual({
      coverage: "hybrid",
      targets: [target],
    });
    expect(
      createVcsWatchPlan(
        getVcsAdapter("jj"),
        operationFromInput({ ...input, options: { vcs: "jj" } }),
        {
          cwd: "/repo",
        },
      ),
    ).toEqual({ coverage: "poll-only", targets: [] });
  });

  test("names the adapter and operation for non-stash unsupported operations", () => {
    const adapter = {
      id: "custom",
      name: "Custom VCS",
      detect: () => null,
      operations: {},
    } satisfies VcsAdapter;
    const input = {
      kind: "vcs",
      staged: false,
      options: { vcs: "custom" },
    } satisfies VcsDiffCommandInput;

    expect(
      createUnsupportedVcsOperationError(adapter, operationFromInput(input).kind).message,
    ).toBe("Custom VCS does not support working-tree-diff.");
  });
});
