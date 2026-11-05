/**
 * Builds the feedback submission Hunk sends to the Hunk team through Modem's feedback endpoint,
 * and the disclosure text both surfaces show before anything is sent.
 *
 * `hunk feedback` and the TUI's Help → Send feedback form both validate a draft, build the payload,
 * and render the disclosure here, so the CLI preview, the TUI warning, and the request body come
 * from one field list. Every field the payload can carry is listed in `FEEDBACK_DISCLOSED_FIELDS`
 * and mapped to a disclosure phrase; adding a field without a phrase does not compile. This module
 * is pure and performs no I/O. The request itself lives in `send.ts`, which callers load only after
 * the person confirms.
 */

/** The domain the disclosure names. `send.test.ts` pins the real request host inside it. */
export const FEEDBACK_DESTINATION_DOMAIN = "modem.dev";

/** Where bug reports that need a reproduction belong instead. */
export const FEEDBACK_ISSUES_URL = "https://github.com/modem-dev/hunk/issues";

/** Modem's limit on the message, after trimming. */
export const FEEDBACK_MESSAGE_MAX_LENGTH = 4096;

/** Modem's limit on the optional reply address. */
export const FEEDBACK_EMAIL_MAX_LENGTH = 320;

/** Which Hunk surface collected the feedback. */
export type FeedbackSurface = "tui" | "cli";

/** The exact JSON body sent to Modem. Nothing outside these fields is ever sent. */
export interface FeedbackPayload {
  submission_id: string;
  message: string;
  source: "tui";
  release: string;
  tags: {
    category: "user_feedback";
    os: string;
    surface: FeedbackSurface;
  };
  email?: string;
}

/** Every payload field, by its dotted path. The field-set test holds the payload to this list. */
export const FEEDBACK_DISCLOSED_FIELDS = [
  "submission_id",
  "message",
  "source",
  "release",
  "tags.category",
  "tags.os",
  "tags.surface",
  "email",
] as const;

export type FeedbackDisclosedField = (typeof FEEDBACK_DISCLOSED_FIELDS)[number];

/**
 * `constantLabel` marks fixed values that are identical for every install and say nothing about the
 * person (`source: "tui"`, `tags.category`, `tags.surface`). The disclosure leaves them out; any
 * field that varies per person or machine needs a phrase the person reads.
 */
type FeedbackDisclosurePhrase =
  | "message"
  | "version"
  | "os"
  | "constantLabel"
  | "submissionId"
  | "email";

/**
 * Which disclosure phrase covers each field. The record type requires an entry per field, so a new
 * payload field cannot ship without being named in the text people agree to.
 */
export const FEEDBACK_FIELD_PHRASES: Record<FeedbackDisclosedField, FeedbackDisclosurePhrase> = {
  submission_id: "submissionId",
  message: "message",
  source: "constantLabel",
  release: "version",
  "tags.category": "constantLabel",
  "tags.os": "os",
  "tags.surface": "constantLabel",
  email: "email",
};

/** The facts about this install that the payload carries. */
export interface FeedbackEnvironment {
  /** The Hunk version, from `resolveCliVersion()`. */
  version: string;
  /** `process.platform`, without any OS release or kernel detail. */
  platform: string;
}

/** What the person wrote, before validation. */
export interface FeedbackDraft {
  message: string;
  email?: string;
}

/** A draft that satisfies Modem's limits, with whitespace trimmed and an empty email dropped. */
export interface ValidFeedbackDraft {
  message: string;
  email?: string;
}

export type FeedbackDraftValidation =
  | { ok: true; draft: ValidFeedbackDraft }
  | { ok: false; error: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
};

/** Return the human-readable name the disclosure uses for one `process.platform` value. */
export function formatFeedbackPlatform(platform: string) {
  return PLATFORM_LABELS[platform] ?? platform;
}

/** Check a draft against Modem's limits so an invalid message fails before any prompt or request. */
export function validateFeedbackDraft(draft: FeedbackDraft): FeedbackDraftValidation {
  const message = draft.message.trim();
  if (message.length === 0) {
    return { ok: false, error: "Write a message first." };
  }

  if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      error: `The message is ${message.length.toLocaleString("en-US")} characters; the limit is ${FEEDBACK_MESSAGE_MAX_LENGTH.toLocaleString("en-US")}.`,
    };
  }

  const email = draft.email?.trim() ?? "";
  if (email.length === 0) {
    return { ok: true, draft: { message } };
  }

  if (email.length > FEEDBACK_EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(email)) {
    return {
      ok: false,
      error: "That email address doesn't look right. Leave it empty to skip it.",
    };
  }

  return { ok: true, draft: { message, email } };
}

/** Generate the per-draft idempotency key Modem dedupes retries on. It identifies nothing else. */
export function createFeedbackSubmissionId() {
  return Bun.randomUUIDv7();
}

/** Build the exact request body for one validated draft. */
export function buildFeedbackPayload(
  draft: ValidFeedbackDraft,
  options: FeedbackEnvironment & { surface: FeedbackSurface; submissionId: string },
): FeedbackPayload {
  return {
    submission_id: options.submissionId,
    message: draft.message,
    source: "tui",
    release: options.version,
    tags: {
      category: "user_feedback",
      os: options.platform,
      surface: options.surface,
    },
    ...(draft.email ? { email: draft.email } : {}),
  };
}

/** Return the dotted path of every field present in one payload, for the field-set test. */
export function listFeedbackPayloadFields(payload: FeedbackPayload): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "object" && value !== null) {
      fields.push(...Object.keys(value).map((nested) => `${key}.${nested}`));
    } else {
      fields.push(key);
    }
  }

  return fields;
}

/**
 * Render the disclosure as paragraphs, using the actual version and OS that will be sent.
 *
 * Both surfaces show this full text: the CLI before its `[y/N]` prompt and the TUI form above its
 * input. Pass `includesEmail` when the person entered an address so the text names it too.
 */
export function describeFeedbackDisclosure(
  environment: FeedbackEnvironment & {
    includesEmail?: boolean;
    /** True for `--skip-confirm`, whose run sends without asking; the text then says so. */
    skipsConfirmation?: boolean;
  },
): string[] {
  // Paragraphs may hold several lines; a line starting with "- " is a bullet, which each surface
  // wraps with a hanging indent.
  const platform = formatFeedbackPlatform(environment.platform);
  return [
    [
      `This goes to Modem (${FEEDBACK_DESTINATION_DOMAIN}), who make Hunk, along with:`,
      `- your Hunk version (${environment.version}) and OS (${platform})`,
      environment.includesEmail
        ? "- the email you entered, so the team can reply"
        : "- your email, only if you add one",
      "- a random ID to avoid duplicate retries",
    ].join("\n"),
    "Your IP is used only for rate limiting and isn't stored.",
    ...(environment.skipsConfirmation
      ? ["Sending now without asking, because --skip-confirm was passed."]
      : []),
  ];
}

/** Render the request body exactly as it will be sent, for the CLI preview. */
export function formatFeedbackPreview(payload: FeedbackPayload) {
  return JSON.stringify(payload, null, 2);
}
