import { dirname, resolve } from "node:path";
import { HunkUserError } from "../errors";
import { gitAdapter } from "./git";
import { jjAdapter } from "./jj";
import type { VcsAdapter, VcsDetection, VcsId, VcsReviewInput, VcsReviewOperation } from "./types";

export const vcsAdapters: VcsAdapter[] = [jjAdapter, gitAdapter];

export function getVcsAdapter(id: VcsId): VcsAdapter {
  const adapter = vcsAdapters.find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unsupported VCS: ${id}`);
  }
  return adapter;
}

export function isVcsId(value: unknown): value is VcsId {
  return vcsAdapters.some((adapter) => adapter.id === value);
}

export function detectVcs(cwd: string): VcsDetection | null {
  for (const adapter of vcsAdapters) {
    const detected = adapter.detect(cwd);
    if (detected) {
      return detected;
    }
  }
  return null;
}

export function findVcsRepoRootCandidate(cwd = process.cwd()) {
  let current = resolve(cwd);

  for (;;) {
    if (vcsAdapters.some((adapter) => adapter.detect(current)?.repoRoot === current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function operationFromInput(input: VcsReviewInput): VcsReviewOperation {
  switch (input.kind) {
    case "vcs":
      return { kind: "working-tree-diff", input };
    case "show":
      return { kind: "revision-show", input };
    case "stash-show":
      return { kind: "stash-show", input };
  }
}

export function createUnsupportedVcsOperationError(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
) {
  if (operation.kind === "stash-show") {
    return new HunkUserError("`hunk stash show` requires Git VCS mode.", [
      'Set `vcs = "git"` in Hunk config, then try again.',
    ]);
  }

  return new HunkUserError(`${adapter.name} does not support ${operation.kind}.`, [
    "Use a supported VCS mode or command for this repository.",
  ]);
}
