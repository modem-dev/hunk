import { randomUUID } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };

/**
 * PLACEHOLDER — replace with the ingest URL for Modem's production API before shipping.
 * Overridable via HUNK_MODEM_INGEST_URL for local/staging testing.
 */
const MODEM_INGEST_URL = "https://ingest.modem.dev";

/**
 * PLACEHOLDER — Ben must fill this in with the dedicated "hunk" project's public key from
 * Modem's org (Settings → Public Keys). Keys look like `modem_<32hex>` and are safe to embed
 * in a distributed binary (Sentry-DSN model: public-by-design, revocable). Overridable via
 * HUNK_MODEM_FEEDBACK_KEY for local/staging testing.
 */
const MODEM_FEEDBACK_PUBLIC_KEY = "modem_PLACEHOLDER_REPLACE_ME";

const FEEDBACK_SUBMIT_TIMEOUT_MS = 10_000;

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Resolve the ingest URL feedback should be POSTed to, honoring the test/staging override. */
function resolveIngestUrl(env: NodeJS.ProcessEnv = process.env) {
  return env.HUNK_MODEM_INGEST_URL?.trim() || MODEM_INGEST_URL;
}

/** Resolve the embedded public key used to authenticate feedback submissions. */
function resolveFeedbackPublicKey(env: NodeJS.ProcessEnv = process.env) {
  return env.HUNK_MODEM_FEEDBACK_KEY?.trim() || MODEM_FEEDBACK_PUBLIC_KEY;
}

/** Return whether the resolved public key is still the shipped placeholder. */
function isPlaceholderFeedbackKey(key: string) {
  return key.length === 0 || key === MODEM_FEEDBACK_PUBLIC_KEY;
}

export interface SubmitFeedbackInput {
  description: string;
  email?: string;
}

export type SubmitFeedbackResult =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "network-error" | "http-error" };

export interface SubmitFeedbackDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  now?: () => Date;
}

/** Build the `feedback.created` APIEvent envelope for one feedback submission. */
export function buildFeedbackEventPayload(
  input: SubmitFeedbackInput,
  now: () => Date = () => new Date(),
) {
  const createdAt = now().toISOString();
  const email = input.email?.trim();

  return {
    event_type: "feedback.created" as const,
    created_at: createdAt,
    client: {
      // Modem's APIEventClientSchema requires a two-segment `scope/name` slug
      // (see CLIENT_NAME_PATTERN); a bare "hunk" is rejected at ingest.
      name: "hunk/cli",
      version: packageJson.version,
    },
    body: {
      data: {
        source_message_id: randomUUID(),
        ...(email
          ? {
              author: {
                source_author_id: email,
                email,
                is_bot: false,
              },
            }
          : {}),
        content: input.description,
        type: "feedback" as const,
        source: "user" as const,
        metadata: {
          platform: process.platform,
          app_version: packageJson.version,
        },
      },
    },
  };
}

/**
 * Submit user feedback directly to Modem's ingest pipeline. Never throws — all failure modes
 * (missing key, network error, non-2xx response) resolve to a tagged failure result so callers
 * (the TUI dialog) can show a message without risking an unhandled rejection.
 */
export async function submitFeedback(
  input: SubmitFeedbackInput,
  deps: SubmitFeedbackDeps = {},
): Promise<SubmitFeedbackResult> {
  const env = deps.env ?? process.env;
  const fetchImpl: FetchImpl = deps.fetchImpl ?? fetch;
  const publicKey = resolveFeedbackPublicKey(env);

  if (isPlaceholderFeedbackKey(publicKey)) {
    return { ok: false, reason: "not-configured" };
  }

  const ingestUrl = resolveIngestUrl(env);
  const payload = buildFeedbackEventPayload(input, deps.now);

  try {
    const response = await fetchImpl(`${ingestUrl}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-modem-public-key": publicKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FEEDBACK_SUBMIT_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, reason: "http-error" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "network-error" };
  }
}
