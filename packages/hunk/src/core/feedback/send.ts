/**
 * Sends one confirmed feedback submission to Modem's feedback endpoint.
 *
 * `hunk feedback` and the TUI form import this module dynamically, and only after the person has
 * confirmed a specific submission, so an unconfirmed run never loads the code that knows the
 * endpoint or the token. It holds the only copy of both: a source-boundary test fails if either
 * appears anywhere else. Building and disclosing the payload belongs to `payload.ts`.
 *
 * Results distinguish a failure Modem reported from an `unconfirmed` send, where a timeout, a dropped
 * connection, or the person's abort leaves Hunk unable to know whether Modem recorded it. Retrying
 * an unconfirmed send is safe: the `submission_id` is reused and Modem dedupes on it.
 */

import { FEEDBACK_ISSUES_URL, type FeedbackPayload } from "./payload";

const FEEDBACK_ENDPOINT_URL = "https://ingest.modem.dev/feedback";

/**
 * The Hunk feedback channel's token. Modem documents feedback tokens as safe to ship in published
 * binaries: they can only submit to their channel and cannot read anything. Empty until the
 * channel exists, in which case every send reports `unavailable` without making a request.
 */
const FEEDBACK_CHANNEL_TOKEN = "";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_TRANSIENT_RETRIES = 1;
const MAX_CONFLICT_RETRIES = 2;
const DEFAULT_CONFLICT_RETRY_MS = 1_000;

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FeedbackSendResult =
  | { kind: "sent"; id: string }
  | { kind: "unconfirmed"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "unavailable"; message: string };

export interface FeedbackSendDeps {
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** The person's abort, such as `esc` while the TUI form is sending. */
  signal?: AbortSignal;
  /** Override the shipped channel token. Tests only. */
  token?: string;
  /** Wait between retries. Tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

export const FEEDBACK_UNCONFIRMED_MESSAGE =
  "Hunk couldn't confirm that Modem received this. It may have arrived. Sending again won't create a duplicate.";

const UNAVAILABLE_MESSAGE = `Feedback is unavailable in this version of Hunk. Please open a GitHub issue instead: ${FEEDBACK_ISSUES_URL}`;

/** Return the endpoint URL, so `send.test.ts` can pin the disclosed host to the real one. */
export function feedbackEndpointUrl() {
  return FEEDBACK_ENDPOINT_URL;
}

/** Wait for one retry delay. */
function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Read `Retry-After` in seconds, falling back to the endpoint's documented one second. */
function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_CONFLICT_RETRY_MS;
}

/** Read the first validation detail Modem returned, for a `400` message. */
async function readFirstDetail(response: Response) {
  try {
    const body = (await response.json()) as { error?: unknown; details?: unknown };
    const details = body.details;
    if (Array.isArray(details) && details.length > 0) {
      const first = details[0];
      return typeof first === "string" ? first : JSON.stringify(first);
    }

    if (typeof details === "object" && details !== null) {
      const [first] = Object.entries(details);
      if (first) {
        return `${first[0]}: ${typeof first[1] === "string" ? first[1] : JSON.stringify(first[1])}`;
      }
    }

    return typeof body.error === "string" ? body.error : "no details";
  } catch {
    return "no details";
  }
}

/** Read the submission's event ID from a `202` body. */
async function readAcceptedId(response: Response) {
  try {
    const body = (await response.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : "";
  } catch {
    return "";
  }
}

/** Run one request with its own timeout, also ending early when the person aborts. */
async function attempt(
  payload: FeedbackPayload,
  token: string,
  deps: FeedbackSendDeps,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  const forwardAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    return await (deps.fetchImpl ?? fetch)(FEEDBACK_ENDPOINT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Replaces Bun's default, which would also announce the runtime version.
        "User-Agent": "hunk",
      },
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timeout);
    deps.signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Send one confirmed submission, retrying only where the endpoint says a retry is safe. */
export async function sendFeedback(
  payload: FeedbackPayload,
  deps: FeedbackSendDeps = {},
): Promise<FeedbackSendResult> {
  const token = deps.token ?? FEEDBACK_CHANNEL_TOKEN;
  if (token.length === 0) {
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }

  const sleep = deps.sleep ?? defaultSleep;
  let transientRetries = 0;
  let conflictRetries = 0;

  while (true) {
    if (deps.signal?.aborted) {
      return { kind: "unconfirmed", message: FEEDBACK_UNCONFIRMED_MESSAGE };
    }

    let response: Response;
    try {
      response = await attempt(payload, token, deps);
    } catch {
      // Once the bytes may be out, a dropped connection or abort cannot prove nothing was stored.
      if (deps.signal?.aborted || transientRetries >= MAX_TRANSIENT_RETRIES) {
        return { kind: "unconfirmed", message: FEEDBACK_UNCONFIRMED_MESSAGE };
      }

      transientRetries += 1;
      continue;
    }

    if (response.status >= 200 && response.status < 300) {
      return { kind: "sent", id: await readAcceptedId(response) };
    }

    if (response.status === 409 && conflictRetries < MAX_CONFLICT_RETRIES) {
      conflictRetries += 1;
      await sleep(retryAfterMs(response));
      continue;
    }

    if (response.status >= 500 && transientRetries < MAX_TRANSIENT_RETRIES) {
      transientRetries += 1;
      continue;
    }

    return describeFailure(response);
  }
}

/** Map a final non-success response to the message the person sees. */
async function describeFailure(response: Response): Promise<FeedbackSendResult> {
  switch (response.status) {
    case 400:
    case 413:
    case 415:
      return {
        kind: "failed",
        message: `Modem rejected the message: ${await readFirstDetail(response)}. This is a Hunk bug; please report it at ${FEEDBACK_ISSUES_URL}.`,
      };
    case 401:
    case 403:
      return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
    case 409:
      return { kind: "unconfirmed", message: FEEDBACK_UNCONFIRMED_MESSAGE };
    case 429:
      return { kind: "failed", message: "Too much feedback right now. Try again in a minute." };
    default:
      return { kind: "failed", message: "Modem couldn't record the feedback. Try again later." };
  }
}
