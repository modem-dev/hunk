import { createSessionBrokerProtocolParsers } from "@hunk/session-broker";
import { z } from "zod";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  parseHunkReviewActionEnvelope,
  parseHunkReviewResourceReadEnvelope,
} from "../reviewProtocol";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
} from "../types";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { cliInputSchema, hunkCommandResultSchemas } from "../protocolSchemas";

const selectorFields = {
  sessionId: z.string().min(1).max(128).optional(),
  sessionPath: z.string().min(1).max(4096).optional(),
  repoRoot: z.string().min(1).max(4096).optional(),
  repoBoundary: z.string().min(1).max(4096).optional(),
};
const side = z.enum(["old", "new"]);
const positive = z.int().positive();
const nonnegative = z.int().nonnegative();
const optionalString = z.string().min(1).max(4096).optional();
const commentItem = z.strictObject({
  filePath: z.string().min(1).max(4096),
  hunkIndex: nonnegative.optional(),
  side: side.optional(),
  line: positive.optional(),
  summary: z.string().min(1).max(4096),
  rationale: optionalString,
  markup: optionalString,
  author: optionalString,
});

const commandInputs = {
  comment: z.strictObject({
    ...selectorFields,
    filePath: z.string().min(1).max(4096),
    hunkIndex: nonnegative.optional(),
    side: side.optional(),
    line: positive.optional(),
    summary: z.string().min(1).max(4096),
    rationale: optionalString,
    markup: optionalString,
    author: optionalString,
    reveal: z.boolean().optional(),
  }),
  comment_batch: z.strictObject({
    ...selectorFields,
    comments: z.array(commentItem),
    revealMode: z.enum(["none", "first"]).optional(),
  }),
  navigate_to_hunk: z.strictObject({
    ...selectorFields,
    filePath: optionalString,
    hunkIndex: nonnegative.optional(),
    side: side.optional(),
    line: positive.optional(),
    commentDirection: z.enum(["next", "prev"]).optional(),
  }),
  reload_session: z.strictObject({
    ...selectorFields,
    nextInput: cliInputSchema,
    sourcePath: optionalString,
  }),
  remove_comment: z.strictObject({
    ...selectorFields,
    commentId: z.string().min(1).max(128),
  }),
  clear_comments: z.strictObject({
    ...selectorFields,
    filePath: optionalString,
    includeUser: z.boolean().optional(),
  }),
  read_review_resource: z
    .strictObject({
      ...selectorFields,
      protocolVersion: z.literal(HUNK_REVIEW_PROTOCOL_VERSION),
      actor: z.unknown(),
      request: z.unknown(),
    })
    .refine(
      ({ protocolVersion, actor, request }) =>
        parseHunkReviewResourceReadEnvelope({ protocolVersion, actor, request }).ok,
    ),
  apply_review_action: z
    .strictObject({
      ...selectorFields,
      protocolVersion: z.literal(HUNK_REVIEW_PROTOCOL_VERSION),
      generation: z.string(),
      expectedStateRevision: nonnegative.optional(),
      actor: z.unknown(),
      action: z.unknown(),
    })
    .refine(
      ({ protocolVersion, generation, expectedStateRevision, actor, action }) =>
        parseHunkReviewActionEnvelope({
          protocolVersion,
          generation,
          ...(expectedStateRevision === undefined ? {} : { expectedStateRevision }),
          actor,
          action,
        }).ok,
    ),
  highlight: z.strictObject({
    ...selectorFields,
    filePath: z.string().min(1).max(4096),
    side,
    line: positive,
    start: nonnegative,
    end: positive,
    tone: z.enum(["match", "current", "info", "warning", "error", "dim"]).optional(),
    reveal: z.boolean().optional(),
  }),
  clear_highlights: z.strictObject({
    ...selectorFields,
    filePath: optionalString,
  }),
} as const;

const failure = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "unknown-resource",
    "resource-unavailable",
    "resource-too-large",
    "resource-integrity",
    "invalid-range",
    "stale-generation",
    "invalid-request",
    "file-not-found",
    "hunk-not-found",
    "gap-not-found",
    "draft-missing",
    "note-not-found",
    "missing-fact",
  ]),
  message: z.string(),
  currentGeneration: z.string(),
});
const results = {
  comment: hunkCommandResultSchemas.comment,
  comment_batch: hunkCommandResultSchemas.comment_batch,
  navigate_to_hunk: hunkCommandResultSchemas.navigate_to_hunk,
  reload_session: hunkCommandResultSchemas.reload_session,
  remove_comment: hunkCommandResultSchemas.remove_comment,
  clear_comments: hunkCommandResultSchemas.clear_comments,
  read_review_resource: z.union([
    failure,
    z.strictObject({
      ok: z.literal(true),
      chunk: z.strictObject({
        generation: z.string(),
        resourceId: z.string(),
        offset: nonnegative,
        byteLength: nonnegative,
        encoding: z.literal("base64"),
        data: z.string(),
        contentDigest: z.string(),
        contentSize: nonnegative,
        eof: z.boolean(),
      }),
    }),
  ]),
  apply_review_action: z.union([
    failure,
    z.strictObject({
      ok: z.literal(true),
      generation: z.string(),
      stateRevision: nonnegative,
    }),
  ]),
  highlight: hunkCommandResultSchemas.highlight,
  clear_highlights: hunkCommandResultSchemas.clear_highlights,
} as const;

/** Parse with one strict Hunk schema while keeping Zod diagnostics inside the app boundary. */
function schemaParser(schema: z.ZodType) {
  return (value: unknown): unknown | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

/** Fixed Hunk app parser registry shared by the daemon and every producer connection. */
export const hunkSessionProtocolParsers = createSessionBrokerProtocolParsers<
  HunkSessionInfo,
  HunkSessionState,
  HunkSessionServerMessage,
  HunkSessionCommandResult
>({
  appRevision: HUNK_SESSION_DAEMON_VERSION,
  features: [],
  parseRegistration: parseSessionRegistration,
  parseSnapshot: parseSessionSnapshot,
  commands: (Object.keys(commandInputs) as Array<keyof typeof commandInputs>).map((command) => ({
    command,
    version: HUNK_REVIEW_PROTOCOL_VERSION,
    parseInput: schemaParser(commandInputs[command]),
    parseResult: (value: unknown): HunkSessionCommandResult | null => {
      const parsed = results[command].safeParse(value);
      return parsed.success ? (parsed.data as HunkSessionCommandResult) : null;
    },
  })),
});
