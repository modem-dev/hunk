import { z } from "zod";
import type { CliInput } from "../core/run/commandInputs";
import { EXPERIMENTAL_FEATURES } from "../core/run/experimental";
import { parseExtensionReviewDescriptor } from "../core/reviewDescriptor";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import {
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
  type SessionDaemonResponses,
} from "./protocol";

/**
 * Runtime validation for the session daemon's HTTP action surface.
 *
 * `SessionDaemonRequest` is erased at compile time, so without these schemas the daemon trusted
 * whatever JSON arrived on the loopback port. Objects are strict on purpose: an unknown key fails
 * loudly instead of being silently stripped, which also catches a schema that forgot a field the
 * moment a real client sends it. `protocolSchemas.test.ts` type-locks the inferred output to
 * `SessionDaemonRequest`, so protocol and schema cannot drift.
 */

const selectorSchema = z.strictObject({
  sessionId: z.string().optional(),
  sessionPath: z.string().optional(),
  repoRoot: z.string().optional(),
  repoBoundary: z.string().optional(),
});

const sideSchema = z.enum(["old", "new"]);
const sessionDaemonActionSchema = z.enum([
  "list",
  "get",
  "context",
  "review",
  "navigate",
  "reload",
  "comment-add",
  "comment-apply",
  "comment-list",
  "comment-rm",
  "comment-clear",
  "highlight-add",
  "highlight-clear",
]);

const sessionDaemonCapabilitiesSchema = z.strictObject({
  version: z.literal(HUNK_SESSION_API_VERSION),
  daemonVersion: z.literal(HUNK_SESSION_DAEMON_VERSION),
  actions: z.array(sessionDaemonActionSchema),
});

const rangeEndpointsSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
});

const commonOptionsSchema = z.strictObject({
  mode: z.enum(["auto", "split", "stack"]).optional(),
  cursorLine: z.enum(["row", "number", "off"]).optional(),
  vcs: z.string().optional(),
  theme: z.string().optional(),
  agentContext: z.string().optional(),
  pager: z.boolean().optional(),
  watch: z.boolean().optional(),
  experimental: z.boolean().optional(),
  fast: z.boolean().optional(),
  excludeUntracked: z.boolean().optional(),
  lineNumbers: z.boolean().optional(),
  tabWidth: z.int().positive().optional(),
  fileGap: z.int().nonnegative().optional(),
  hunkGap: z.int().nonnegative().optional(),
  wrapLines: z.boolean().optional(),
  hunkHeaders: z.boolean().optional(),
  menuBar: z.boolean().optional(),
  sidebar: z.union([z.boolean(), z.literal("auto")]).optional(),
  agentNotes: z.boolean().optional(),
  copyDecorations: z.boolean().optional(),
  promptSaveViewPreferences: z.boolean().optional(),
  transparentBackground: z.boolean().optional(),
  colorMoved: z.boolean().optional(),
  extensions: z.boolean().optional(),
  extensionPaths: z.array(z.string()).optional(),
});

/** Parses the complete reloadable CLI input tree carried inside a command. */
export const cliInputSchema: z.ZodType<CliInput> = z.union([
  z.strictObject({
    kind: z.literal("vcs"),
    range: z.string().optional(),
    rangeEndpoints: z.never().optional(),
    staged: z.boolean(),
    pathspecs: z.array(z.string()).optional(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("vcs"),
    range: z.never().optional(),
    rangeEndpoints: rangeEndpointsSchema,
    staged: z.boolean(),
    pathspecs: z.array(z.string()).optional(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("show"),
    ref: z.string().optional(),
    pathspecs: z.array(z.string()).optional(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("stash-show"),
    ref: z.string().optional(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("diff"),
    left: z.string(),
    right: z.string(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("patch"),
    file: z.string().optional(),
    text: z.string().optional(),
    options: commonOptionsSchema,
  }),
  z.strictObject({
    kind: z.literal("difftool"),
    left: z.string(),
    right: z.string(),
    path: z.string().optional(),
    options: commonOptionsSchema,
  }),
]) satisfies z.ZodType<CliInput>;

const commentApplyItemSchema = z.strictObject({
  filePath: z.string(),
  hunkNumber: z.int().positive().optional(),
  side: sideSchema.optional(),
  line: z.int().positive().optional(),
  summary: z.string(),
  rationale: z.string().optional(),
  markup: z.string().optional(),
  author: z.string().optional(),
});

export const sessionDaemonRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("get"), selector: selectorSchema }),
  z.strictObject({ action: z.literal("context"), selector: selectorSchema }),
  z.strictObject({
    action: z.literal("review"),
    selector: selectorSchema,
    includePatch: z.boolean().optional(),
    includeNotes: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("navigate"),
    selector: selectorSchema,
    filePath: z.string().optional(),
    hunkNumber: z.int().positive().optional(),
    side: sideSchema.optional(),
    line: z.int().positive().optional(),
    commentDirection: z.enum(["next", "prev"]).optional(),
    commentId: z.string().min(1).optional(),
  }),
  z.strictObject({
    action: z.literal("reload"),
    selector: selectorSchema,
    nextInput: cliInputSchema,
    sourcePath: z.string().optional(),
  }),
  z.strictObject({
    action: z.literal("comment-add"),
    selector: selectorSchema,
    filePath: z.string(),
    side: sideSchema,
    line: z.int().positive(),
    summary: z.string(),
    rationale: z.string().optional(),
    markup: z.string().optional(),
    author: z.string().optional(),
    reveal: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("comment-apply"),
    selector: selectorSchema,
    comments: z.array(commentApplyItemSchema),
    revealMode: z.enum(["none", "first"]),
  }),
  z.strictObject({
    action: z.literal("comment-list"),
    selector: selectorSchema,
    filePath: z.string().optional(),
    type: z.enum(["live", "all", "ai", "agent", "user"]).optional(),
  }),
  z.strictObject({
    action: z.literal("comment-rm"),
    selector: selectorSchema,
    commentId: z.string(),
  }),
  z.strictObject({
    action: z.literal("comment-clear"),
    selector: selectorSchema,
    filePath: z.string().optional(),
    includeUser: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("highlight-add"),
    selector: selectorSchema,
    filePath: z.string(),
    side: sideSchema,
    line: z.int().positive(),
    start: z.int().nonnegative(),
    end: z.int().positive(),
    tone: z.enum(["match", "current", "info", "warning", "error", "dim"]).optional(),
    reveal: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("highlight-clear"),
    selector: selectorSchema,
    filePath: z.string().optional(),
  }),
]);

const nonnegative = z.int().nonnegative();
const positive = z.int().positive();
const lineRangeSchema = z.tuple([nonnegative, nonnegative]);
const inputKindSchema = z.enum(["vcs", "show", "stash-show", "diff", "patch", "difftool"]);
const experimentalFeaturesSchema = z.array(z.enum(EXPERIMENTAL_FEATURES));
const reviewDescriptorSchema = z.custom<ExtensionReviewDescriptor>(
  (value) => parseExtensionReviewDescriptor(value) !== null,
);
const terminalLocationSchema = z.strictObject({
  source: z.string(),
  tty: z.string().optional(),
  windowId: z.string().optional(),
  tabId: z.string().optional(),
  paneId: z.string().optional(),
  terminalId: z.string().optional(),
  sessionId: z.string().optional(),
});
const terminalSchema = z.strictObject({
  program: z.string().optional(),
  locations: z.array(terminalLocationSchema),
});
const fileSummarySchema = z.strictObject({
  id: z.string(),
  path: z.string(),
  previousPath: z.string().optional(),
  additions: nonnegative,
  deletions: nonnegative,
  hunkCount: nonnegative,
});
const reviewHunkSchema = z.strictObject({
  index: nonnegative,
  header: z.string(),
  oldRange: lineRangeSchema.optional(),
  newRange: lineRangeSchema.optional(),
});
const selectedHunkSchema = reviewHunkSchema.omit({ header: true });
const reviewFileSchema = fileSummarySchema.extend({
  patch: z.string().optional(),
  hunks: z.array(reviewHunkSchema),
});
const liveCommentSchema = z.strictObject({
  commentId: z.string(),
  filePath: z.string(),
  hunkIndex: nonnegative,
  side: sideSchema,
  line: positive,
  summary: z.string(),
  rationale: z.string().optional(),
  author: z.string().optional(),
  createdAt: z.string(),
});
const reviewNoteSchema = z.strictObject({
  noteId: z.string(),
  parentId: z.string().optional(),
  source: z.enum(["ai", "agent", "user"]),
  filePath: z.string(),
  hunkIndex: nonnegative.optional(),
  oldRange: lineRangeSchema.optional(),
  newRange: lineRangeSchema.optional(),
  body: z.string(),
  title: z.string().optional(),
  author: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  editable: z.boolean(),
});
const snapshotSchema = z.strictObject({
  updatedAt: z.string(),
  state: z.strictObject({
    selectedFileId: z.string().optional(),
    selectedFilePath: z.string().optional(),
    selectedHunkIndex: nonnegative,
    selectedHunkOldRange: lineRangeSchema.optional(),
    selectedHunkNewRange: lineRangeSchema.optional(),
    showAgentNotes: z.boolean(),
    noteMarkupWidth: nonnegative.optional(),
    liveCommentCount: nonnegative,
    liveComments: z.array(liveCommentSchema),
    reviewNoteCount: nonnegative.optional(),
    reviewNotes: z.array(reviewNoteSchema).optional(),
    reviewPublication: z
      .strictObject({ generation: z.string(), stateRevision: nonnegative })
      .optional(),
  }),
});
const listedSessionSchema = z.strictObject({
  sessionId: z.string(),
  pid: positive,
  cwd: z.string(),
  repoRoot: z.string().optional(),
  launchedAt: z.string(),
  terminal: terminalSchema.optional(),
  inputKind: inputKindSchema,
  title: z.string(),
  sourceLabel: z.string(),
  experimentalFeatures: experimentalFeaturesSchema.optional(),
  review: reviewDescriptorSchema.optional(),
  fileCount: nonnegative,
  files: z.array(fileSummarySchema),
  snapshot: snapshotSchema,
});
const selectedContextSchema = z.strictObject({
  sessionId: z.string(),
  title: z.string(),
  sourceLabel: z.string(),
  cwd: z.string().optional(),
  repoRoot: z.string().optional(),
  inputKind: inputKindSchema,
  experimentalFeatures: experimentalFeaturesSchema.optional(),
  review: reviewDescriptorSchema.optional(),
  selectedFile: fileSummarySchema.nullable(),
  selectedHunk: selectedHunkSchema.nullable(),
  showAgentNotes: z.boolean(),
  noteMarkupWidth: nonnegative.optional(),
  liveCommentCount: nonnegative,
});
const reviewSchema = z.strictObject({
  sessionId: z.string(),
  title: z.string(),
  sourceLabel: z.string(),
  cwd: z.string().optional(),
  repoRoot: z.string().optional(),
  inputKind: inputKindSchema,
  experimentalFeatures: experimentalFeaturesSchema.optional(),
  review: reviewDescriptorSchema.optional(),
  selectedFile: reviewFileSchema.nullable(),
  selectedHunk: reviewHunkSchema.nullable(),
  showAgentNotes: z.boolean(),
  liveCommentCount: nonnegative,
  reviewNoteCount: nonnegative.optional(),
  reviewNotes: z.array(reviewNoteSchema).optional(),
  files: z.array(reviewFileSchema),
});

const appliedCommentSchema = z.strictObject({
  commentId: z.string(),
  fileId: z.string(),
  filePath: z.string(),
  hunkIndex: nonnegative,
  side: sideSchema,
  line: positive,
  markupWidth: nonnegative.optional(),
  markupNotes: z.array(z.string()).optional(),
});

/** Strict Hunk command result schemas shared by broker and HTTP response validation. */
export const hunkCommandResultSchemas = {
  comment: appliedCommentSchema,
  comment_batch: z.strictObject({ applied: z.array(appliedCommentSchema) }),
  navigate_to_hunk: z.strictObject({
    fileId: z.string(),
    filePath: z.string(),
    hunkIndex: nonnegative,
    selectedHunk: selectedHunkSchema.optional(),
    revealed: z.enum(["line", "hunk"]).optional(),
    side: sideSchema.optional(),
    line: positive.optional(),
  }),
  reload_session: z.strictObject({
    sessionId: z.string(),
    inputKind: inputKindSchema,
    title: z.string(),
    sourceLabel: z.string(),
    fileCount: nonnegative,
    selectedFilePath: z.string().optional(),
    selectedHunkIndex: nonnegative,
  }),
  remove_comment: z.strictObject({
    commentId: z.string(),
    removed: z.boolean(),
    remainingCommentCount: nonnegative,
    source: z.enum(["ai", "agent", "user"]).optional(),
  }),
  clear_comments: z.strictObject({
    removedCount: nonnegative,
    remainingCommentCount: nonnegative,
    filePath: z.string().optional(),
    includeUser: z.boolean().optional(),
    removedLiveCommentCount: nonnegative.optional(),
    removedUserNoteCount: nonnegative.optional(),
    remainingLiveCommentCount: nonnegative.optional(),
    remainingUserNoteCount: nonnegative.optional(),
  }),
  highlight: z.strictObject({
    fileId: z.string(),
    filePath: z.string(),
    hunkIndex: nonnegative,
    side: sideSchema,
    line: positive,
    start: nonnegative,
    end: positive,
    tone: z.enum(["match", "current", "info", "warning", "error", "dim"]),
    fileMarkCount: nonnegative,
    revealed: z.enum(["line", "hunk"]).optional(),
  }),
  clear_highlights: z.strictObject({
    removedCount: nonnegative,
    remainingCount: nonnegative,
    filePath: z.string().optional(),
  }),
} as const;

const daemonResponseSchemas = {
  list: z.strictObject({ sessions: z.array(listedSessionSchema) }),
  get: z.strictObject({ session: listedSessionSchema }),
  context: z.strictObject({ context: selectedContextSchema }),
  review: z.strictObject({ review: reviewSchema }),
  navigate: z.strictObject({
    result: hunkCommandResultSchemas.navigate_to_hunk,
  }),
  reload: z.strictObject({ result: hunkCommandResultSchemas.reload_session }),
  "comment-add": z.strictObject({ result: hunkCommandResultSchemas.comment }),
  "comment-apply": z.strictObject({
    result: hunkCommandResultSchemas.comment_batch,
  }),
  "comment-list": z.strictObject({
    comments: z.array(z.union([liveCommentSchema, reviewNoteSchema])),
  }),
  "comment-rm": z.strictObject({
    result: hunkCommandResultSchemas.remove_comment,
  }),
  "comment-clear": z.strictObject({
    result: hunkCommandResultSchemas.clear_comments,
  }),
  "highlight-add": z.strictObject({
    result: hunkCommandResultSchemas.highlight,
  }),
  "highlight-clear": z.strictObject({
    result: hunkCommandResultSchemas.clear_highlights,
  }),
} satisfies {
  [Action in SessionDaemonAction]: z.ZodType<SessionDaemonResponses[Action]>;
};

/** Strictly parse the response associated with one Hunk session API action. */
export function parseSessionDaemonResponse<Action extends SessionDaemonAction>(
  action: Action,
  value: unknown,
): SessionDaemonResponses[Action] {
  const result = daemonResponseSchemas[action].safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Hunk session daemon response for ${action}.`);
  }
  return result.data as SessionDaemonResponses[Action];
}

/** Parse one exact cross-process Hunk daemon capability response. */
export function parseSessionDaemonCapabilities(value: unknown): SessionDaemonCapabilities | null {
  const result = sessionDaemonCapabilitiesSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Compose one readable rejection reason from the first schema issue. */
function describeFirstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid request";
  }

  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Validate one raw daemon HTTP body into a typed session request. */
export function parseSessionDaemonRequest(value: unknown): SessionDaemonRequest {
  const result = sessionDaemonRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid session API request: ${describeFirstIssue(result.error)}`);
  }

  return result.data;
}
