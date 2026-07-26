import { dirname, relative, resolve } from "node:path";
import { HUNK_DEFAULT_VCS_DETECTION_PRIORITY } from "../../extension-api/types";
import { getBundledVcsAdapters } from "../../extensions/bundled";
import { HunkUserError } from "../errors";
import { GitVcsAdapter } from "./git";
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

/**
 * Order adapters the way detection consults them: highest priority first.
 *
 * The sort is stable, so adapters that declare the same priority keep the order
 * they were assembled in — core Git, then bundled extensions in load order,
 * then user extensions in registration order.
 */
function orderByDetectionPriority(adapters: readonly VcsAdapter[]): VcsAdapter[] {
  return [...adapters].sort(
    (left, right) =>
      (right.detectionPriority ?? HUNK_DEFAULT_VCS_DETECTION_PRIORITY) -
      (left.detectionPriority ?? HUNK_DEFAULT_VCS_DETECTION_PRIORITY),
  );
}

/** Adapters that are part of the product: core Git plus the bundled extension tier. */
let builtInAdapters: VcsAdapter[] | undefined;

/**
 * Return the adapters Hunk ships with, assembled once per process.
 *
 * Core Git and the bundled Jujutsu and Sapling extensions are one list from
 * here on: they are all product behavior, they all take part in first-class
 * detection, and they all reserve their id against user extensions. Bundled
 * loading is resolved lazily so this module can be imported from anywhere in
 * the graph without depending on module evaluation order.
 */
export function getBuiltInVcsAdapters(): readonly VcsAdapter[] {
  builtInAdapters ??= orderByDetectionPriority([DEFAULT_VCS_ADAPTER, ...getBundledVcsAdapters()]);
  return builtInAdapters;
}

/**
 * Combine the built-in adapters with the session's user-extension ones.
 *
 * This is the one place adapter order is decided. Ids owned by a built-in
 * backend are dropped here (callers report the skip once, at registration
 * time), and everything else sorts by `detectionPriority` — which puts user
 * adapters below Git unless they explicitly ask for more.
 */
export function resolveVcsAdapters(extraAdapters: readonly VcsAdapter[] = []): VcsAdapter[] {
  const builtIns = getBuiltInVcsAdapters();
  if (extraAdapters.length === 0) {
    return [...builtIns];
  }

  return orderByDetectionPriority([
    ...builtIns,
    ...extraAdapters.filter((adapter) => !isVcsId(adapter.id)),
  ]);
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

/** Report whether one value names a backend Hunk ships with (core Git or a bundled one). */
export function isVcsId(value: unknown): value is VcsId {
  return getBuiltInVcsAdapters().some((adapter) => adapter.id === value);
}

/**
 * Detect the nearest containing VCS checkout.
 *
 * Distance decides first, so a Git checkout nested inside a jj workspace is
 * reviewed as Git. Detection priority only breaks same-root ties — the
 * colocated case, where one directory carries markers for two backends.
 */
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

/**
 * Walk upward for the nearest directory a shipped backend calls a repo root.
 *
 * Config resolution and extension discovery both run before user extensions
 * exist, so this deliberately consults built-ins only — which, since jj and
 * Sapling are bundled, still covers every backend Hunk ships with.
 */
export function findVcsRepoRootCandidate(cwd = process.cwd()) {
  let current = resolve(cwd);

  for (;;) {
    if (getBuiltInVcsAdapters().some((adapter) => adapter.detect(current)?.repoRoot === current)) {
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
  const supportingAdapter = getBuiltInVcsAdapters().find(
    (candidate) => candidate.operations?.[operationKind],
  );
  if (operationKind === "stash-show" && supportingAdapter) {
    return new HunkUserError(`\`hunk stash show\` requires ${supportingAdapter.name} VCS mode.`, [
      `Set \`vcs = "${supportingAdapter.id}"\` in Hunk config, then try again.`,
    ]);
  }

  return new HunkUserError(`${adapter.name} does not support ${operationKind}.`, [
    "Use a supported VCS mode or command for this repository.",
  ]);
}
