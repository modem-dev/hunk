import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUnsupportedVcsOperationError,
  detectVcs,
  findVcsRepoRootCandidate,
  getVcsAdapter,
  isVcsId,
  operationFromInput,
  vcsAdapters,
} from ".";
import type { ShowCommandInput, StashShowCommandInput, VcsCommandInput } from "../types";
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
  test("registers Git and Jujutsu adapters", () => {
    expect(vcsAdapters.map((adapter) => adapter.id)).toEqual(["jj", "git"]);
    expect(getVcsAdapter("git").capabilities.reviewOperations.has("stash-show")).toBe(true);
    expect(getVcsAdapter("jj").capabilities.reviewOperations.has("stash-show")).toBe(false);
  });

  test("validates VCS ids from the registered adapter list", () => {
    expect(isVcsId("git")).toBe(true);
    expect(isVcsId("jj")).toBe(true);
    expect(isVcsId("sl")).toBe(false);
    expect(isVcsId("hg")).toBe(false);
  });

  test("finds repo root candidates through adapter detection instead of id-derived markers", () => {
    const repo = createTempDir("hunk-vcs-custom-marker-");
    const nested = join(repo, "src", "nested");
    mkdirSync(join(repo, ".custom"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    const adapter: VcsAdapter = {
      id: "git",
      name: "Custom marker test adapter",
      capabilities: { reviewOperations: new Set(), watchSignatures: false },
      detect(cwd) {
        return cwd === repo ? { id: "git", repoRoot: repo } : null;
      },
      async loadReview() {
        throw new Error("not used");
      },
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
    } satisfies VcsCommandInput;
    const showInput = {
      kind: "show",
      ref: "HEAD",
      options: { vcs: "git" },
    } satisfies ShowCommandInput;
    const stashInput = {
      kind: "stash-show",
      options: { vcs: "git" },
    } satisfies StashShowCommandInput;

    expect(operationFromInput(diffInput)).toEqual({ kind: "working-tree-diff", input: diffInput });
    expect(operationFromInput(showInput)).toEqual({ kind: "revision-show", input: showInput });
    expect(operationFromInput(stashInput)).toEqual({ kind: "stash-show", input: stashInput });
  });

  test("creates friendly errors for unsupported adapter operations", () => {
    const adapter = getVcsAdapter("jj");
    const input = {
      kind: "stash-show",
      options: { vcs: "jj" },
    } satisfies StashShowCommandInput;

    expect(createUnsupportedVcsOperationError(adapter, operationFromInput(input)).message).toBe(
      "`hunk stash show` requires Git VCS mode.",
    );
  });
});
