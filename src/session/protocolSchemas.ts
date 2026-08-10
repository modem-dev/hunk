import { z } from "zod";
import type { CliInput } from "../core/types";
import type { SessionDaemonRequest } from "./protocol";

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

/**
 * Reload payloads embed a full parsed CLI input tree whose deep shape is owned by the CLI
 * parser, so this envelope check is intentionally shallow: an object with a string `kind`
 * discriminant. A well-formed-but-wrong tree still reaches the reload path, where thrown errors
 * surface through the daemon's JSON error response rather than a schema rejection.
 */
const nextInputSchema = z.custom<CliInput>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === "string",
);

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
    action: z.literal("open"),
    selector: selectorSchema,
    tailscale: z.boolean().optional(),
  }),
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
  }),
  z.strictObject({
    action: z.literal("reload"),
    selector: selectorSchema,
    nextInput: nextInputSchema,
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
]);

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
