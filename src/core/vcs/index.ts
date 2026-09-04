import { relative, resolve } from "node:path";
import { HUNK_DEFAULT_VCS_DETECTION_PRIORITY } from "../../extension-api/types";
import { HunkUserError } from "../run/errors";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryInput,
  ExtensionVcsHistoryReviewAction,
  ExtensionVcsHistoryReviewOptions,
} from "../../extension-api/types";
import type { CliInput } from "../run/commandInputs";
import type {
  VcsAdapter,
  VcsCatalog,
  VcsDetection,
  VcsId,
  VcsLoadContext,
  VcsHistorySource,
  VcsOperation,
  VcsPatchResult,
  VcsReviewInput,
  VcsReviewOperation,
  VcsReviewOperationKind,
} from "./types";

/** Order adapters by detection priority while preserving assembly order for ties. */
function orderByDetectionPriority(adapters: readonly VcsAdapter[]): VcsAdapter[] {
  return [...adapters].sort(
    (left, right) =>
      (right.detectionPriority ?? HUNK_DEFAULT_VCS_DETECTION_PRIORITY) -
      (left.detectionPriority ?? HUNK_DEFAULT_VCS_DETECTION_PRIORITY),
  );
}

/** Create the complete provider-neutral adapter catalog used by a composition root. */
export function createVcsCatalog(
  adapters: readonly VcsAdapter[],
  defaultAdapterId: VcsId,
  reservedIds: Iterable<VcsId> = adapters.map((adapter) => adapter.id),
): VcsCatalog {
  return {
    adapters: orderByDetectionPriority(adapters),
    defaultAdapterId,
    reservedIds: new Set(reservedIds),
  };
}

/** Add user adapters without allowing them to replace ids owned by the base catalog. */
export function extendVcsCatalog(
  base: VcsCatalog,
  extraAdapters: readonly VcsAdapter[],
): VcsCatalog {
  const claimed = new Set(base.adapters.map((adapter) => adapter.id));
  const accepted = extraAdapters.filter((adapter) => {
    if (base.reservedIds.has(adapter.id) || claimed.has(adapter.id)) {
      return false;
    }
    claimed.add(adapter.id);
    return true;
  });

  return createVcsCatalog([...base.adapters, ...accepted], base.defaultAdapterId, base.reservedIds);
}

/** Return the catalog's fallback adapter. */
export function getDefaultVcsAdapter(catalog: VcsCatalog): VcsAdapter {
  const adapter = catalog.adapters.find((candidate) => candidate.id === catalog.defaultAdapterId);
  if (!adapter) {
    throw new HunkUserError(`Hunk's default ${catalog.defaultAdapterId} backend failed to load.`, [
      "Reinstall Hunk, or report this at https://github.com/modem-dev/hunk/issues.",
    ]);
  }
  return adapter;
}

/** Return the configured adapter, or the catalog default when no id was supplied. */
export function getConfiguredVcsAdapter(id: VcsId | undefined, catalog: VcsCatalog): VcsAdapter {
  return id ? getVcsAdapter(id, catalog) : getDefaultVcsAdapter(catalog);
}

/** Resolve one adapter id from the complete session catalog. */
export function getVcsAdapter(id: VcsId, catalog: VcsCatalog): VcsAdapter {
  const adapter = catalog.adapters.find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unsupported VCS: ${id}`);
  }
  return adapter;
}

/** Report whether a catalog reserves one adapter id against user extensions. */
export function isVcsId(value: unknown, catalog: VcsCatalog): value is VcsId {
  return typeof value === "string" && catalog.reservedIds.has(value);
}

/** Detect the nearest containing checkout across one complete catalog. */
export function detectVcs(cwd: string, catalog: VcsCatalog): VcsDetection | null {
  const start = resolve(cwd);
  let bestDetection: VcsDetection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const adapter of catalog.adapters) {
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

/** Return whether one CLI input loads a review through a VCS adapter. */
export function isVcsReviewInput(input: CliInput): input is VcsReviewInput {
  return input.kind === "vcs" || input.kind === "show" || input.kind === "stash-show";
}

/** Translate a CLI review input into the neutral operation map key. */
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

/** Return one operation handler from an adapter's optional operation map. */
export function getVcsOperation(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
): VcsOperation<VcsReviewInput> | undefined {
  return adapter.operations?.[operation.kind] as VcsOperation<VcsReviewInput> | undefined;
}

/** Load a review through a provider-neutral adapter operation. */
export async function loadVcsReview(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
  catalog: VcsCatalog,
): Promise<VcsPatchResult> {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind, catalog);
  }
  return await handler.load(operation.input, context);
}

/** Open a provider-neutral history source or report that the selected backend lacks one. */
export async function openVcsHistory(
  adapter: VcsAdapter,
  input: ExtensionVcsHistoryInput,
  context: VcsLoadContext,
  catalog: VcsCatalog,
): Promise<VcsHistorySource> {
  if (!adapter.history) {
    const supportingAdapter = catalog.adapters.find((candidate) => candidate.history);
    throw new HunkUserError(`\`hunk log\` is not supported by ${adapter.name}.`, [
      ...(supportingAdapter
        ? [`Use \`--vcs ${supportingAdapter.id}\` in a compatible repository.`]
        : []),
      "Use a VCS adapter that implements history browsing.",
    ]);
  }
  return await adapter.history.open(input, context);
}

/** Ask the selected provider how one opaque history item should open in review. */
export async function planVcsHistoryReview(
  adapter: VcsAdapter,
  commit: ExtensionVcsHistoryCommit,
  context: VcsLoadContext,
  options?: ExtensionVcsHistoryReviewOptions,
): Promise<ExtensionVcsHistoryReviewAction> {
  if (!adapter.history) {
    throw new HunkUserError(`\`hunk log\` is not supported by ${adapter.name}.`, [
      "Use a VCS adapter that implements history browsing.",
    ]);
  }
  return await adapter.history.planReview(commit, context, options);
}

/** Build an adapter event plan, falling back to signature polling. */
export function createVcsWatchPlan(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
  catalog: VcsCatalog,
) {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind, catalog);
  }
  return handler.watchPlan?.(operation.input, context) ?? { coverage: "poll-only", targets: [] };
}

/** Build an adapter watch signature when the selected operation supports it. */
export function createVcsWatchSignature(
  adapter: VcsAdapter,
  operation: VcsReviewOperation,
  context: VcsLoadContext,
  catalog: VcsCatalog,
) {
  const handler = getVcsOperation(adapter, operation);
  if (!handler) {
    throw createUnsupportedVcsOperationError(adapter, operation.kind, catalog);
  }
  if (!handler.watchSignature) {
    throw new Error(`${adapter.name} does not support watch signatures for ${operation.kind}.`);
  }
  return handler.watchSignature(operation.input, context);
}

/** Build a user-facing unsupported-operation error using the active catalog. */
export function createUnsupportedVcsOperationError(
  adapter: VcsAdapter,
  operationKind: VcsReviewOperationKind,
  catalog: VcsCatalog,
) {
  const supportingAdapter = catalog.adapters.find(
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
