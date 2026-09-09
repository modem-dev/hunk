/**
 * Agent-facing error messages for the `hunk session` surface.
 *
 * Every message quoted by the generated `packages/hunk/skills/hunk-review/SKILL.md` "Common errors" section is
 * defined (or contract-tested) here, so the skill can never quote wording the CLI no longer
 * throws. Throw sites import these builders instead of repeating string literals.
 */

import type { AgentCommandConstraint } from "./surface";

/** Format flag choices as a human list: `--a, --b, or --c` for three, `--a or --b` for two. */
function formatFlagChoices(flags: readonly string[]) {
  if (flags.length <= 2) {
    return flags.join(" or ");
  }

  return `${flags.slice(0, -1).join(", ")}, or ${flags[flags.length - 1]}`;
}

/** The message thrown when one declared flag-group constraint is violated. */
export function constraintViolationMessage(constraint: AgentCommandConstraint) {
  if (constraint.kind === "exactly-one") {
    return `Specify exactly one ${constraint.label}: ${formatFlagChoices(constraint.flags)}.`;
  }

  return `Specify either ${formatFlagChoices(constraint.flags)}, not both.`;
}

/** Reload invoked without the `--` separator or without a nested review command. */
export const RELOAD_SEPARATOR_MESSAGE =
  "Pass the replacement Hunk command after `--`, for example `hunk session reload <session-id> -- diff`.";

/** `comment apply` invoked without opting into the stdin JSON batch. */
export const COMMENT_APPLY_STDIN_MESSAGE = "Pass --stdin to read batch comments from stdin JSON.";

/** `highlight add` invoked with an empty or inverted character range. */
export const HIGHLIGHT_RANGE_MESSAGE =
  "Highlight --end must be greater than --start; the range is [start, end) with an exclusive end.";

/** The daemon is reachable but no live Hunk session has registered with it. */
export const NO_ACTIVE_SESSIONS_MESSAGE =
  "No active Hunk sessions are registered with the daemon. Open Hunk and wait for it to connect.";

/** A navigation or comment target referenced a file outside the loaded review. */
export function noDiffFileMatchesMessage(filePath: string) {
  return `No diff file matches ${filePath}.`;
}

/**
 * Raw diff text could not be read back from the live session that published it.
 *
 * `review --include-patch` reads patch bodies as review resources rather than from the
 * registration, so this is what an agent sees when the session reloaded mid-read, went
 * away, or served content that failed verification.
 */
export function reviewResourceUnavailableMessage(filePath: string) {
  return `Could not read the raw diff for ${filePath} from the live session.`;
}

/** One skill-documented error: the quoted message (or prefix) plus the remedy agents should try. */
export interface AgentErrorDoc {
  /**
   * Text quoted in the skill. A trailing ` ...` marks a prefix of a longer dynamic message;
   * tests strip it and assert the real thrown message starts with the rest.
   */
  quote: string;
  /** Skill guidance rendered after the quote. */
  remedy: string;
}

/**
 * The generated skill's "Common errors" section, in display order. Messages owned by
 * `@hunk/session-broker-core` stay defined there (the broker core is app-agnostic); their quotes
 * are bound to the real wording by contract tests in `agentErrors.test.ts`.
 */
export const AGENT_ERROR_DOCS: AgentErrorDoc[] = [
  {
    quote: "No diff file matches ...",
    remedy: "the file is not in the loaded review. Check `context`, then `reload` if needed.",
  },
  {
    quote: "No active Hunk sessions",
    remedy:
      "if Hunk is visibly running, localhost may be blocked by the agent sandbox; retry with network/sandbox escalation. Otherwise ask the user to open Hunk.",
  },
  {
    quote: "Multiple active sessions match",
    remedy: "pass `<session-id>` explicitly.",
  },
  {
    quote: "No active session matches session path ...",
    remedy:
      "for advanced split-path reloads, verify the live window `Path` via `hunk session get` or `list`, then use `--session-path`.",
  },
  {
    quote: "Pass the replacement Hunk command after `--`",
    remedy: "include `--` before the nested `diff` / `show` command.",
  },
  {
    quote: COMMENT_APPLY_STDIN_MESSAGE,
    remedy: "`comment apply` only reads its batch payload from stdin.",
  },
  {
    quote: "Specify exactly one navigation target",
    remedy: "pick one of `--hunk`, `--old-line`, or `--new-line`.",
  },
  {
    quote: "Specify exactly one comment target",
    remedy: "pass `comment add` one of `--old-line` or `--new-line`.",
  },
  {
    quote: "Specify exactly one highlight target",
    remedy: "pass `highlight add` one of `--old-line` or `--new-line`.",
  },
  {
    quote: "Highlight --end must be greater than --start",
    remedy: "offsets are `[start, end)` UTF-16 code units into the line text; end is exclusive.",
  },
  {
    quote: "Specify either --next-comment or --prev-comment, not both.",
    remedy: "choose one comment-navigation direction.",
  },
  {
    quote: "Could not read the raw diff for ...",
    remedy:
      "the session reloaded or closed while `--include-patch` was reading it. Re-run `review`; drop `--include-patch` if you only need file and hunk structure.",
  },
];

/** Strip the trailing ` ...` prefix marker from one documented quote. */
export function agentErrorQuotePrefix(doc: AgentErrorDoc) {
  return doc.quote.endsWith(" ...") ? doc.quote.slice(0, -" ...".length) : doc.quote;
}
