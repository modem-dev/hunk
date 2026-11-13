/**
 * Sends the page's review actions to the session, the one place the page writes shared state.
 *
 * Every write the page makes — notes created, edited, replied to, and removed, agent-note
 * visibility, the shared filter, and the focus report — goes through `send`, which builds the
 * protocol envelope: the generation the page is showing, an optional `expectedStateRevision`
 * where a precondition matters, and the actor `{ clientId, kind: "browser" }`. The client id is
 * random per tab and never stored; the review link refuses every other actor kind
 * (`forbidden-actor`). Selection is never sent except the focus report's `selection/anchor`.
 *
 * Failures come back as codes from the shared vocabulary, shown with the shared catalog's
 * sentence (`reviewErrorCatalog.ts`); the page never words a failure itself. The retry policy is
 * stated once here: a `stale-generation` refusal means the session reloaded after the page
 * prepared the action, so `send` waits (bounded) for the page to show the new generation and
 * retries, at most `MAX_STALE_RETRIES` times, while the caller says the action still means
 * something. Anything else is reported to the caller as is.
 */
import type { HunkReviewActionAppliedV1, HunkReviewActionV1 } from "../../session/reviewProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../session/reviewProtocol";
import type { ReviewMirror } from "../mirror/reviewMirror";
import { reviewFailureMessage } from "../session/failureMessages";
import {
  ReviewApiError,
  type ReviewApiClient,
  type ReviewApiErrorCode,
} from "../transport/apiClient";

/** How many times a stale-generation refusal is retried against the newer generation. */
export const MAX_STALE_RETRIES = 2;

/** How long one retry waits for the page to show the session's newer generation. */
export const STALE_GENERATION_WAIT_MS = 5_000;

/** What one sent action came to. */
export type ReviewActionOutcome =
  | { ok: true; applied: HunkReviewActionAppliedV1 }
  | { ok: false; code: ReviewApiErrorCode; message: string };

export interface ReviewActionOptions {
  /** Refuse the action unless the session is still at this state revision. */
  expectedStateRevision?: number;
  /** Whether the action still means something after the review reloaded; retried while true. */
  stillMeaningful?: () => boolean;
  signal?: AbortSignal;
}

/** A random per-tab client identity: never stored, so every tab is its own actor. */
export function createBrowserClientId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `browser-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The outcome for one failure, worded by the shared catalog. */
export function reviewActionFailure(error: unknown): Extract<ReviewActionOutcome, { ok: false }> {
  const failure =
    error instanceof ReviewApiError
      ? error
      : new ReviewApiError("unreadable", "The review action failed in an unexpected way.");
  return { ok: false, code: failure.code, message: reviewFailureMessage(failure) };
}

export interface ReviewActionSenderOptions {
  client: ReviewApiClient;
  /** Where the page is: the generation every envelope names. */
  mirror: Pick<ReviewMirror, "getSnapshot" | "subscribe">;
  clientId?: string;
  /** Whether the session has ended; every send then fails with `session-ended`, unposted. */
  isEnded?: () => boolean;
}

/** Sends review actions for one page. */
export class ReviewActionSender {
  readonly clientId: string;

  constructor(private readonly options: ReviewActionSenderOptions) {
    this.clientId = options.clientId ?? createBrowserClientId();
  }

  /** Send one action, retrying a stale generation by the stated policy. */
  async send(
    action: HunkReviewActionV1,
    options: ReviewActionOptions = {},
  ): Promise<ReviewActionOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.options.isEnded?.()) {
        return reviewActionFailure(new ReviewApiError("session-ended", "The session has ended."));
      }
      const generation = this.options.mirror.getSnapshot().address?.generation;
      if (!generation) {
        return reviewActionFailure(new ReviewApiError("no-publication", "No review is shown."));
      }
      try {
        const applied = await this.options.client.postAction(
          {
            protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
            generation,
            ...(options.expectedStateRevision !== undefined
              ? { expectedStateRevision: options.expectedStateRevision }
              : {}),
            actor: { clientId: this.clientId, kind: "browser" },
            action,
          },
          options.signal,
        );
        return { ok: true, applied };
      } catch (error) {
        const stale = error instanceof ReviewApiError && error.code === "stale-generation";
        if (!stale || attempt >= MAX_STALE_RETRIES) return reviewActionFailure(error);
        const moved = await this.waitForGenerationAfter(generation, options.signal);
        if (!moved || !(options.stillMeaningful?.() ?? true)) return reviewActionFailure(error);
      }
    }
  }

  /** Resolve true once the page shows a generation other than `generation`, false on timeout. */
  private waitForGenerationAfter(generation: string, signal?: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const current = () => this.options.mirror.getSnapshot().address?.generation;
      if (current() !== generation) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (moved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(moved);
      };
      const unsubscribe = this.options.mirror.subscribe(() => {
        if (current() !== generation) finish(true);
      });
      const timer = setTimeout(() => finish(false), STALE_GENERATION_WAIT_MS);
      signal?.addEventListener("abort", () => finish(false), { once: true });
    });
  }
}
