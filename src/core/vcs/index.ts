import { dirname, relative, resolve } from "node:path";
import { HunkUserError } from "../errors";
import { GitVcsAdapter } from "./git";
import { JjVcsAdapter } from "./jj";
import { SaplingVcsAdapter } from "./sl";
import type {
  VcsAdapter,
  VcsDetection,
  VcsId,
  VcsLoadContext,
  VcsOperation,
  VcsPatchResult,
  VcsReviewInput,
  VcsReviewOperation,
  VcsReviewOperationKind,
} from "./types";

export const DEFAULT_VCS_ADAPTER = GitVcsAdapter;
export const vcsAdapters: VcsAdapter[] = [JjVcsAdapter, SaplingVcsAdapter, DEFAULT_VCS_ADAPTER];

/**
 * Combine built-in adapters with the session's extension-contributed ones.
 *
 * Built-ins stay first so they keep priority in both detection tie-breaks and
 * id lookup; an extension adapter that reuses a built-in id is dropped here
 * (callers report the skip once, at registration time).
 */
export function resolveVcsAdapters(extraAdapters: readonly VcsAdapter[] = []): VcsAdapter[] {
  if (extraAdapters.length === 0) {
    return vcsAdapters;
  }

  return [...vcsAdapters, ...extraAdapters.filter((adapter) => !isVcsId(adapter.id))];
}

/** Return the fallback adapter used when config has not selected a provider explicitly. */
export function getDefaultVcsAdapter() {
  return DEFAULT_VCS_ADAPTER;
}

/** Return the configured adapter, or the default adapter when no VCS id was supplied. */
export function getConfiguredVcsAdapter(
  id: VcsId | undefined,
  extraAdapters: readonly VcsAdapter[] = [],
): VcsAdapter {
  return id ? getVcsAdapter(id, extraAdapters) : getDefaultVcsAdapter();
}

export function getVcsAdapter(id: VcsId, extraAdapters: readonly VcsAdapter[] = []): VcsAdapter {
  const adapter = resolveVcsAdapters(extraAdapters).find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unsupported VCS: ${id}`);
  }
  return adapter;
}

/** Report whether one value names a built-in VCS backend. */
export function isVcsId(value: unknown): value is VcsId {
  return vcsAdapters.some((adapter) => adapter.id === value);
}

/** Detect the nearest containing VCS checkout, using adapter order only to break same-root ties. */
export function detectVcs(
  cwd: string,
  extraAdapters: readonly VcsAdapter[] = [],
): VcsDetection | null {
  const start = resolve(cwd);
  let bestDetection: VcsDetection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const adapter of resolveVcsAdapters(extraAdapters)) {
    // Extension adapters run third-party detection code here; a throwing
    // adapter must not stop the remaining adapters from being consulted.
    let detected: VcsDetection | null;
    try {
      detected = adapter.detect(start);
    } catch {
      continue;
    }

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

/**
 * Return the adapter operation handler for one neutral review operation, if supported.
 *
 * The operation map is optional at the extension-authoring boundary and can be
 * missing entirely on an adapter registered from JavaScript, so a missing map
 * reads the same as a missing operation: unsupported, which callers turn into a
 * `HunkUserError` instead of a TypeError.
 */
export function getVcsOperation(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
): VcsOperation<VcsReviewInput> | undefined {
  return adapter.operations?.[operation.kind] as VcsOperation<VcsReviewInput> | undefined;
}

/** Load a review through the adapter operation map instead of adapter-local switch dispatch. */
export async function loadVcsReview(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
): Promise<VcsPatchResult> {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind);
  }

  return await handler.load(operation.input, context);
}

/** Build an adapter-backed event plan, falling back to signature polling when unsupported. */
export function createVcsWatchPlan(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
) {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind);
  }

  return handler.watchPlan?.(operation.input, context) ?? { coverage: "poll-only", targets: [] };
}

/** Build an adapter-backed watch signature when the selected operation supports it. */
export function createVcsWatchSignature(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
) {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind);
  }
  if (!handler.watchSignature) {
    throw new Error(`${adapter.name} does not support watch signatures for ${operation.kind}.`);
  }

  return handler.watchSignature(operation.input, context);
}

export function createUnsupportedVcsOperationError(
  adapter: VcsAdapter,
  operationKind: VcsReviewOperationKind,
) {
  const supportingAdapter = vcsAdapters.find((candidate) => candidate.operations?.[operationKind]);
  if (operationKind === "stash-show" && supportingAdapter) {
    return new HunkUserError(`\`hunk stash show\` requires ${supportingAdapter.name} VCS mode.`, [
      `Set \`vcs = "${supportingAdapter.id}"\` in Hunk config, then try again.`,
    ]);
  }

  return new HunkUserError(`${adapter.name} does not support ${operationKind}.`, [
    "Use a supported VCS mode or command for this repository.",
  ]);
}
