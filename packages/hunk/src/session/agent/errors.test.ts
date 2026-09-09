import { describe, expect, test } from "bun:test";
import { resolveSessionTarget } from "@hunk/session-broker-core";
import {
  AGENT_ERROR_DOCS,
  agentErrorQuotePrefix,
  COMMENT_APPLY_STDIN_MESSAGE,
  constraintViolationMessage,
  HIGHLIGHT_RANGE_MESSAGE,
  NO_ACTIVE_SESSIONS_MESSAGE,
  noDiffFileMatchesMessage,
  RELOAD_SEPARATOR_MESSAGE,
  reviewResourceUnavailableMessage,
} from "./errors";
import {
  COMMENT_DIRECTION_CONSTRAINT,
  COMMENT_TARGET_CONSTRAINT,
  HIGHLIGHT_TARGET_CONSTRAINT,
  NAVIGATE_TARGET_CONSTRAINT,
} from "./surface";

function createTestBrokerSession(sessionId: string) {
  return {
    sessionId,
    cwd: `/tmp/${sessionId}`,
    repoRoot: "/tmp/shared-repo",
    title: `title-${sessionId}`,
    snapshot: { updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** Capture the message a callback throws so broker errors can be prefix-checked. */
function thrownMessage(callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the callback to throw.");
}

describe("agent error messages", () => {
  test("formats exactly-one constraints with an Oxford-comma flag list", () => {
    expect(constraintViolationMessage(NAVIGATE_TARGET_CONSTRAINT)).toBe(
      "Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.",
    );
    expect(constraintViolationMessage(COMMENT_TARGET_CONSTRAINT)).toBe(
      "Specify exactly one comment target: --old-line <n> or --new-line <n>.",
    );
  });

  test("formats at-most-one constraints as an either/or message", () => {
    expect(constraintViolationMessage(COMMENT_DIRECTION_CONSTRAINT)).toBe(
      "Specify either --next-comment or --prev-comment, not both.",
    );
  });

  test("binds every documented quote to a real thrown message", () => {
    const sessions = [createTestBrokerSession("one"), createTestBrokerSession("two")];
    // One real message per AGENT_ERROR_DOCS entry, in the same display order. Broker-owned
    // messages are produced by the broker itself so the doc quotes track its actual wording.
    const realMessages = [
      noDiffFileMatchesMessage("src/App.tsx"),
      NO_ACTIVE_SESSIONS_MESSAGE,
      thrownMessage(() => resolveSessionTarget(sessions, { repoRoot: "/tmp/shared-repo" })),
      thrownMessage(() => resolveSessionTarget(sessions, { sessionPath: "/tmp/missing" })),
      RELOAD_SEPARATOR_MESSAGE,
      COMMENT_APPLY_STDIN_MESSAGE,
      constraintViolationMessage(NAVIGATE_TARGET_CONSTRAINT),
      constraintViolationMessage(COMMENT_TARGET_CONSTRAINT),
      constraintViolationMessage(HIGHLIGHT_TARGET_CONSTRAINT),
      HIGHLIGHT_RANGE_MESSAGE,
      constraintViolationMessage(COMMENT_DIRECTION_CONSTRAINT),
      reviewResourceUnavailableMessage("src/App.tsx"),
    ];

    // Quotes match messages by prefix rather than array position, so reordering
    // AGENT_ERROR_DOCS cannot silently pair a quote with the wrong message.
    expect(realMessages).toHaveLength(AGENT_ERROR_DOCS.length);
    for (const doc of AGENT_ERROR_DOCS) {
      const prefix = agentErrorQuotePrefix(doc);
      expect(realMessages.some((message) => message.startsWith(prefix))).toBe(true);
    }

    for (const message of realMessages) {
      const claims = AGENT_ERROR_DOCS.filter((doc) =>
        message.startsWith(agentErrorQuotePrefix(doc)),
      );
      expect(claims).toHaveLength(1);
    }
  });
});
