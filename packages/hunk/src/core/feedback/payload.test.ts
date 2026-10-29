import { describe, expect, test } from "bun:test";
import {
  buildFeedbackPayload,
  createFeedbackSubmissionId,
  describeFeedbackDisclosure,
  FEEDBACK_DISCLOSED_FIELDS,
  FEEDBACK_FIELD_PHRASES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  formatFeedbackPreview,
  listFeedbackPayloadFields,
  validateFeedbackDraft,
} from "./payload";

const environment = { version: "0.24.1", platform: "darwin" };

/** Build one payload from a raw draft, failing the test if the draft is invalid. */
function buildTestFeedbackPayload(draft: { message: string; email?: string }) {
  const validation = validateFeedbackDraft(draft);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  return buildFeedbackPayload(validation.draft, {
    ...environment,
    surface: "cli",
    submissionId: "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  });
}

describe("feedback payload", () => {
  test("carries exactly the disclosed fields when an email is given", () => {
    const payload = buildTestFeedbackPayload({ message: "hi", email: "ada@example.com" });

    expect(listFeedbackPayloadFields(payload).toSorted()).toEqual(
      [...FEEDBACK_DISCLOSED_FIELDS].toSorted(),
    );
  });

  test("omits only the email when none is given", () => {
    const payload = buildTestFeedbackPayload({ message: "hi", email: "  " });

    expect(listFeedbackPayloadFields(payload).toSorted()).toEqual(
      FEEDBACK_DISCLOSED_FIELDS.filter((field) => field !== "email").toSorted(),
    );
  });

  test("builds the documented body", () => {
    expect(buildTestFeedbackPayload({ message: "  Resize loses my place.  " })).toEqual({
      submission_id: "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
      message: "Resize loses my place.",
      source: "tui",
      release: "0.24.1",
      tags: { category: "user_feedback", os: "darwin", surface: "cli" },
    });
  });

  test("previews the exact body that is sent", () => {
    const payload = buildTestFeedbackPayload({ message: "hi" });

    expect(JSON.parse(formatFeedbackPreview(payload))).toEqual(payload);
  });

  test("generates a fresh UUIDv7 per draft", () => {
    const first = createFeedbackSubmissionId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createFeedbackSubmissionId()).not.toBe(first);
  });
});

describe("feedback draft validation", () => {
  test("rejects an empty message", () => {
    expect(validateFeedbackDraft({ message: " \n " })).toEqual({
      ok: false,
      error: "Write a message first.",
    });
  });

  test("rejects a message over Modem's limit and accepts one at it", () => {
    expect(validateFeedbackDraft({ message: "x".repeat(FEEDBACK_MESSAGE_MAX_LENGTH) }).ok).toBe(
      true,
    );
    expect(validateFeedbackDraft({ message: "x".repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1) })).toEqual(
      { ok: false, error: "The message is 4,097 characters; the limit is 4,096." },
    );
  });

  test("rejects a malformed email instead of silently sending it", () => {
    expect(validateFeedbackDraft({ message: "hi", email: "not an email" }).ok).toBe(false);
  });
});

describe("feedback disclosure", () => {
  test("maps every disclosed field to a phrase", () => {
    expect(Object.keys(FEEDBACK_FIELD_PHRASES).toSorted()).toEqual(
      [...FEEDBACK_DISCLOSED_FIELDS].toSorted(),
    );
  });

  test("names the destination, the real version and OS, the label, the ID, and the IP", () => {
    const text = describeFeedbackDisclosure(environment).join("\n");

    expect(text).toContain("Modem (modem.dev)");
    expect(text).toContain("your Hunk version (0.24.1)");
    expect(text).toContain("your operating system (macOS)");
    expect(text).toContain("a label saying the message came from Hunk's terminal app");
    expect(text).toContain("a random ID made just for this message");
    expect(text).toContain("IP address");
    expect(text).toContain("Nothing is sent until you confirm.");
    expect(text).not.toContain("email");
  });

  test("names the email only when one will be sent", () => {
    const text = describeFeedbackDisclosure({ ...environment, includesEmail: true }).join("\n");

    expect(text).toContain("the email address you entered, so the team can reply to you");
  });

  test("falls back to the raw platform name for an unlisted OS", () => {
    expect(describeFeedbackDisclosure({ version: "1.0.0", platform: "aix" })[1]).toContain(
      "your operating system (aix)",
    );
  });
});
