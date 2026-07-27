import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledVcsAdapters } from "../../extensions/default/vcs";
import {
  createUnsupportedVcsOperationError,
  createVcsWatchPlan,
  detectVcs,
  findVcsRepoRootCandidate,
  getBuiltInVcsAdapters,
  getVcsAdapter,
  getDefaultVcsAdapter,
  getVcsOperation,
  isVcsId,
  loadVcsReview,
  operationFromInput,
  resolveVcsAdapters,
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
    // Every one of these comes from the bundled extension tier: there are no
    // core-registered adapters, so this list is purely an ordering of what the
    // bundled factories registered through `hunk.registerVcsAdapter`.
    expect(getBuiltInVcsAdapters().map((adapter) => adapter.id)).toEqual(["jj", "sl", "git"]);
    expect(getBuiltInVcsAdapters()).toEqual(
      [...getBundledVcsAdapters()].sort(
        (left, right) => (right.detectionPriority ?? 0) - (left.detectionPriority ?? 0),
      ),
    );
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

  test("falls back to the bundled Git backend when config names none", () => {
    expect(getDefaultVcsAdapter().id).toBe("git");
    expect(getDefaultVcsAdapter()).toBe(getVcsAdapter("git"));
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

  test("orders built-ins by detection priority, jj and Sapling above the Git baseline", () => {
    const priorities = getBuiltInVcsAdapters().map((adapter) => adapter.detectionPriority ?? 0);
    expect(priorities).toEqual([...priorities].sort((left, right) => right - left));
    expect(getVcsAdapter("jj").detectionPriority).toBeGreaterThan(
      getVcsAdapter("git").detectionPriority ?? 0,
    );
    expect(getVcsAdapter("sl").detectionPriority).toBeGreaterThan(
      getVcsAdapter("git").detectionPriority ?? 0,
    );
  });

  test("assembles built-ins ahead of unprioritized extension adapters", () => {
    const createExtensionAdapter = (id: string, detectionPriority?: number): VcsAdapter => ({
      id,
      name: id,
      detect: () => null,
      operations: {},
      ...(detectionPriority === undefined ? {} : { detectionPriority }),
    });

    expect(
      resolveVcsAdapters([
        createExtensionAdapter("hg"),
        createExtensionAdapter("pijul"),
        // Built-in ids stay reserved, whatever priority an extension claims.
        createExtensionAdapter("git", 1_000),
      ]).map((adapter) => adapter.id),
    ).toEqual(["jj", "sl", "git", "hg", "pijul"]);

    // An extension that explicitly outranks Git is honored: the user's machine.
    expect(
      resolveVcsAdapters([createExtensionAdapter("hg", 500)]).map((adapter) => adapter.id),
    ).toEqual(["hg", "jj", "sl", "git"]);
  });

  test("finds repo root candidates through bundled adapter detection", () => {
    const repo = createTempDir("hunk-vcs-bundled-marker-");
    const nested = join(repo, "src", "nested");
    // `.jj` is only reachable through the bundled Jujutsu extension's detect(),
    // so finding this root proves repo discovery consults the bundled tier.
    mkdirSync(join(repo, ".jj"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(findVcsRepoRootCandidate(nested)).toBe(repo);
  });

  test("detects a colocated jj repository as jj rather than git", () => {
    const repo = createTempDir("hunk-vcs-colocated-jj-");
    const nested = join(repo, "src", "nested");
    // `jj git init --colocate` leaves both markers at the same root, so nothing
    // but detection priority separates them.
    mkdirSync(join(repo, ".jj"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(nested, { recursive: true });

    expect(detectVcs(repo)).toEqual({ id: "jj", repoRoot: repo });
    expect(detectVcs(nested)).toEqual({ id: "jj", repoRoot: repo });
    expect(findVcsRepoRootCandidate(nested)).toBe(repo);
  });

  test("detects a colocated Sapling repository as sl rather than git", () => {
    const repo = createTempDir("hunk-vcs-colocated-sl-");
    mkdirSync(join(repo, ".sl"));
    mkdirSync(join(repo, ".git"));

    expect(detectVcs(repo)).toEqual({ id: "sl", repoRoot: repo });
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

  test("treats a missing operation map as unsupported rather than crashing", async () => {
    // Only reachable from an untyped extension, which is exactly the case that
    // used to reach `adapter.operations[kind]` on undefined and throw a TypeError.
    const adapter = { id: "bare", name: "Bare VCS", detect: () => null } as unknown as VcsAdapter;
    const input = {
      kind: "vcs",
      staged: false,
      options: { vcs: "bare" },
    } satisfies VcsDiffCommandInput;

    expect(getVcsOperation(adapter, operationFromInput(input))).toBeUndefined();
    expect(createUnsupportedVcsOperationError(adapter, "working-tree-diff").message).toBe(
      "Bare VCS does not support working-tree-diff.",
    );
    await expect(
      loadVcsReview(adapter, operationFromInput(input), { cwd: process.cwd() }),
    ).rejects.toThrow("Bare VCS does not support working-tree-diff.");
    expect(() => createVcsWatchPlan(adapter, operationFromInput(input), { cwd: "/repo" })).toThrow(
      "Bare VCS does not support working-tree-diff.",
    );
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
