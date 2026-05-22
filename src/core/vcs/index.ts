import { dirname, relative, resolve } from "node:path";
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

/** Detect the nearest containing VCS checkout, using adapter order only to break same-root ties. */
export function detectVcs(cwd: string): VcsDetection | null {
  const start = resolve(cwd);
  let bestDetection: VcsDetection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const adapter of vcsAdapters) {
    const detected = adapter.detect(start);
    if (!detected) {
      continue;
    }

    const distance = relative(detected.repoRoot, start)
      .split(/[\\/]+/)
      .filter(Boolean).length;
    if (distance < bestDistance) {
      bestDetection = detected;
      bestDistance = distance;
    }
  }

  return bestDetection;
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
