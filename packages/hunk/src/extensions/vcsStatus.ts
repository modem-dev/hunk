import { z } from "zod";
import type {
  ExtensionVcsStatusCapability,
  ExtensionVcsStatusSnapshot,
  ExtensionVcsStatusWorktree,
} from "../extension-api/types";
import { toUserFacingError } from "../core/run/errors";
import { utf8ByteLength } from "../core/review/validation";

const text = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => !value.includes("\0"));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
const maxCollectionEntries = 40_000;
const maxResultTextBytes = 8 * 1024 * 1024;

/** Bound aggregate text after schema copying; only normalized, acyclic fields reach this walk. */
function assertResultTextBudget(value: unknown) {
  let bytes = 0;

  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      bytes += utf8ByteLength(item);
      if (bytes > maxResultTextBytes)
        throw new Error(`Status result text exceeds ${maxResultTextBytes} UTF-8 bytes.`);
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  };

  visit(value);
}

/** Inspect schema-owned fields without walking unknown extension data. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Reject oversized arrays before Zod visits their elements or allocates per-item errors. */
function createCollectionPreflight() {
  let entries = 0;

  return (value: unknown, limit: number, name: string): unknown[] => {
    if (!Array.isArray(value)) return [];
    if (value.length > limit) throw new Error(`Status ${name} exceeds ${limit} entries.`);
    entries += value.length;
    if (entries > maxCollectionEntries)
      throw new Error(`Status collections exceed ${maxCollectionEntries} total entries.`);
    return value;
  };
}

type CollectionPreflight = ReturnType<typeof createCollectionPreflight>;

/** Bound nested ready-operation facts without interpreting malformed states. */
function preflightOperations(value: unknown, check: CollectionPreflight) {
  if (field(value, "state") === "ready") check(field(value, "value"), 5, "operations");
}

/** Bound sibling rows and their operation arrays before schema traversal. */
function preflightSiblings(value: unknown, check: CollectionPreflight) {
  const rows = check(field(value, "worktrees"), 100, "siblings");
  for (const row of rows) {
    const status = field(row, "status");
    if (field(status, "state") === "ready") preflightOperations(field(status, "operations"), check);
  }
}

/** Check all snapshot collections, sharing one budget with embedded sibling facts. */
function preflightSnapshot(value: unknown) {
  const check = createCollectionPreflight();
  check(field(value, "paths"), 20_000, "paths");
  check(field(value, "reviewActions"), 32, "review actions");
  preflightOperations(field(value, "operations"), check);
  const siblingFact = field(value, "siblings");
  if (field(siblingFact, "state") === "ready")
    preflightSiblings(field(siblingFact, "value"), check);
}

/** Bound watch arrays individually and in aggregate before parsing nested targets. */
function preflightWatchPlan(value: unknown) {
  const check = createCollectionPreflight();
  const targets = check(field(value, "targets"), 256, "watch targets");
  for (const target of targets) {
    check(field(target, "sources"), 4, "watch sources");
    const kind = field(target, "kind");
    if (kind === "directory-tree")
      check(field(target, "ignoredRoots"), 20_000, "watch ignored roots");
    if (kind === "directory-entries") check(field(target, "entries"), 20_000, "watch entries");
  }
}

/** Preserve repository membership and the inspected worktree's id/path pairing. */
function validateSiblingRepository(
  rows: { worktree: ExtensionVcsStatusWorktree }[],
  current: ExtensionVcsStatusWorktree,
) {
  if (rows.some((row) => row.worktree.repositoryId !== current.repositoryId))
    throw new Error("Status siblings must belong to the inspected repository.");
  if (
    rows.some(
      ({ worktree: sibling }) => (sibling.id === current.id) !== (sibling.path === current.path),
    )
  ) {
    throw new Error("Status siblings must retain the inspected worktree identity.");
  }
}

/** Copy a bounded status fact while retaining unknown and error semantics. */
function fact<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready"), value }),
    z.object({ state: z.literal("unknown"), reason: text }),
    z.object({ state: z.literal("error"), message: text }),
  ]);
}
const operation = fact(
  z.array(z.enum(["merge", "rebase", "cherry-pick", "revert", "bisect"])).max(5),
);
const worktree = z.object({ id: text, path: text, repositoryId: text });
const head = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: text, revisionId: text }),
  z.object({ kind: z.literal("detached"), revisionId: text }),
  z.object({ kind: z.literal("unborn"), name: text }),
]);
const pathState = z.enum([
  "unchanged",
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "unmerged",
  "untracked",
]);
const siblings = z
  .object({
    truncated: z.boolean(),
    worktrees: z
      .array(
        z.object({
          worktree,
          branch: text.optional(),
          detached: z.boolean(),
          bare: z.boolean(),
          locked: z.string().max(65_536).optional(),
          prunable: z.string().max(65_536).optional(),
          inspectable: z.boolean(),
          status: z.discriminatedUnion("state", [
            z.object({
              state: z.literal("ready"),
              observedAt: timestamp,
              changedPathCount: count,
              conflictCount: count,
              operations: operation,
            }),
            z.object({ state: z.enum(["unavailable", "error"]), message: text }),
          ]),
        }),
      )
      .max(100),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.worktrees.map((row) => row.worktree.id)).size !== value.worktrees.length ||
      new Set(value.worktrees.map((row) => row.worktree.path)).size !== value.worktrees.length
    ) {
      context.addIssue({ code: "custom", message: "Status sibling ids and paths must be unique." });
    }
  });
const snapshot = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: timestamp,
    worktree,
    token: text,
    head,
    upstream: fact(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.enum(["none", "detached", "unborn"]) }),
        z.object({ kind: z.literal("missing"), name: text }),
        z.object({
          kind: z.literal("tracked"),
          name: text,
          ahead: count,
          behind: count,
          fetch: fact(z.object({ timestamp, provenance: z.literal("local-fetch-head-mtime") })),
        }),
      ]),
    ),
    operations: operation,
    paths: z
      .array(
        z.object({
          path: text,
          previousPath: text.optional(),
          index: pathState.optional(),
          worktree: pathState,
          conflict: z.boolean(),
          submodule: z
            .object({
              commitChanged: z.boolean(),
              trackedChanges: z.boolean(),
              untrackedChanges: z.boolean(),
            })
            .optional(),
        }),
      )
      .max(20_000),
    changedPathCount: count,
    reviewActions: z.array(z.object({ id: z.enum(["staged", "unstaged"]), label: text })).max(32),
    siblings: z.union([fact(siblings), z.object({ state: z.literal("loading") })]),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.paths.map((path) => path.path)).size !== value.paths.length ||
      value.changedPathCount !== value.paths.length
    ) {
      context.addIssue({ code: "custom", message: "Status must count unique changed paths." });
    }
    if (
      new Set(value.reviewActions.map((action) => action.id)).size !== value.reviewActions.length
    ) {
      context.addIssue({ code: "custom", message: "Status review action ids must be unique." });
    }
  });

/** Validate and detach provider results before any status surface consumes them. */
export function normalizeVcsStatusSnapshot(value: unknown): ExtensionVcsStatusSnapshot {
  preflightSnapshot(value);
  const result = snapshot.parse(value);
  assertResultTextBudget(result);
  if (result.siblings.state === "ready")
    validateSiblingRepository(result.siblings.value.worktrees, result.worktree);
  return result;
}

/** Wrap the optional public capability with bounded result checks and error translation. */
export function toInternalVcsStatus(value: unknown): ExtensionVcsStatusCapability | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("VCS status must be a capability object.");
  const capability = value as ExtensionVcsStatusCapability;
  const { read, readSiblings, planReview, watchPlan } = capability;
  if (
    typeof read !== "function" ||
    typeof readSiblings !== "function" ||
    typeof planReview !== "function" ||
    (watchPlan !== undefined && typeof watchPlan !== "function")
  ) {
    throw new Error("VCS status must provide read(), readSiblings(), and planReview() functions.");
  }
  /** Translate failures without swallowing cancellation or publishing late results. */
  const run = async <T>(signal: AbortSignal | undefined, task: () => Promise<T>) => {
    signal?.throwIfAborted();
    try {
      const result = await task();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw toUserFacingError(error);
    }
  };
  return {
    read: (input, context) =>
      run(context.signal, async () =>
        normalizeVcsStatusSnapshot(await read.call(capability, { ...input }, context)),
      ),
    readSiblings: (current, context) =>
      run(context.signal, async () => {
        const normalized = normalizeVcsStatusSnapshot(current);
        const inspected = { ...normalized.worktree };
        const value = await readSiblings.call(capability, normalized, context);
        preflightSiblings(value, createCollectionPreflight());
        const result = siblings.parse(value);
        assertResultTextBudget(result);
        validateSiblingRepository(result.worktrees, inspected);
        return result;
      }),
    planReview: (current, actionId, context) =>
      run(context.signal, async () => {
        const normalized = normalizeVcsStatusSnapshot(current);
        if (!normalized.reviewActions.some((action) => action.id === actionId))
          throw new Error("Unknown status review action.");
        const inspectedPath = normalized.worktree.path;
        const value = await planReview.call(capability, normalized, actionId, context);
        const reviewInput = field(value, "input");
        if (reviewInput && typeof reviewInput === "object" && "pathspecs" in reviewInput)
          throw new Error("Status review must not include pathspecs.");
        const result = z
          .object({
            cwd: text,
            input: z.object({
              kind: z.literal("vcs"),
              staged: z.boolean(),
              range: text.optional(),
              rangeEndpoints: z.object({ from: text, to: text }).optional(),
              options: z.object({
                excludeUntracked: z.boolean().optional(),
                colorMoved: z.boolean().optional(),
              }),
            }),
          })
          .parse(value);
        if (result.input.staged !== (actionId === "staged"))
          throw new Error("Status review must match its staged/unstaged action.");
        if (
          result.cwd !== inspectedPath ||
          (result.input.range !== undefined && result.input.rangeEndpoints !== undefined)
        ) {
          throw new Error("Status review must retain its inspected target and one comparison.");
        }
        const { range, rangeEndpoints, ...input } = result.input;
        return {
          cwd: result.cwd,
          input: rangeEndpoints
            ? { ...input, rangeEndpoints }
            : { ...input, ...(range === undefined ? {} : { range }) },
        };
      }),
    ...(watchPlan
      ? {
          watchPlan: (current, context) =>
            run(context.signal, async () => {
              const result = await watchPlan.call(
                capability,
                normalizeVcsStatusSnapshot(current),
                context,
              );
              preflightWatchPlan(result);
              const source = z
                .array(z.enum(["content", "sidecar", "worktree", "vcs-metadata"]))
                .max(4);
              const normalized = z
                .object({
                  coverage: z.enum(["hybrid", "poll-only"]),
                  targets: z
                    .array(
                      z.discriminatedUnion("kind", [
                        z.object({
                          kind: z.literal("directory-tree"),
                          directory: text,
                          ignoredRoots: z.array(text).max(20_000),
                          sources: source,
                        }),
                        z.object({
                          kind: z.literal("directory-entries"),
                          directory: text,
                          entries: z.array(text).max(20_000),
                          sources: source,
                        }),
                      ]),
                    )
                    .max(256),
                })
                .parse(result);
              assertResultTextBudget(normalized);
              return normalized;
            }),
        }
      : {}),
  };
}
