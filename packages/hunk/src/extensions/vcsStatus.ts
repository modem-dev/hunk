import { z } from "zod";
import type {
  ExtensionVcsStatusCapability,
  ExtensionVcsStatusSnapshot,
} from "../extension-api/types";
import { toUserFacingError } from "../core/run/errors";

const text = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => !value.includes("\0"));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime();
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
const siblings = z.object({
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
    reviewActions: z.array(z.object({ id: text, label: text })).max(32),
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
  return snapshot.parse(value);
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
        const result = siblings.parse(
          await readSiblings.call(capability, normalizeVcsStatusSnapshot(current), context),
        );
        if (
          result.worktrees.some(
            (row) => row.worktree.repositoryId !== current.worktree.repositoryId,
          )
        ) {
          throw new Error("Status siblings must belong to the inspected repository.");
        }
        return result;
      }),
    planReview: (current, actionId, context) =>
      run(context.signal, async () => {
        if (!current.reviewActions.some((action) => action.id === actionId))
          throw new Error("Unknown status review action.");
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
          .parse(
            await planReview.call(
              capability,
              normalizeVcsStatusSnapshot(current),
              actionId,
              context,
            ),
          );
        if (
          result.cwd !== current.worktree.path ||
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
              const source = z
                .array(z.enum(["content", "sidecar", "worktree", "vcs-metadata"]))
                .max(4);
              return z
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
            }),
        }
      : {}),
  };
}
