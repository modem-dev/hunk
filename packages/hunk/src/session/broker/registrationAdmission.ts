/**
 * Tells a review session, before it relies on the session daemon, whether the daemon will hold
 * its registration at all.
 *
 * The daemon refuses a session whose registration is over one of its per-session bounds — more
 * files than a registration may list, a resource catalog with more entries than it parses, a
 * register message larger than one websocket frame, or more bytes than it retains per session —
 * and it refuses after the signed hello, by closing the socket. The hello alone therefore cannot
 * tell a session that its review will be served. These checks measure the same registration and
 * snapshot the broker client sends, against the bounds the daemon enforces, so `hunk <review> --web`
 * can refuse with the cause instead of printing a link no daemon will serve, and the broker client
 * can tell a refusal it can never get past from a transient one.
 *
 * Bounds shared by every session (how many sessions, how many bytes in all) depend on what else
 * is registered and stay with the daemon. A well-formed Hunk registration parses to itself, so
 * measuring it here measures what the daemon retains.
 */
import {
  DEFAULT_SESSION_BROKER_LIMITS,
  MAX_REGISTRATION_FILES,
  measureRetainedSessionBytes,
  utf8ByteLength,
  type SessionClientMessage,
} from "@hunk/session-broker-core";
import { MAX_HUNK_REVIEW_CATALOG_RESOURCES } from "../reviewProtocol";
import type { HunkSessionRegistration, HunkSessionSnapshot } from "../types";

/** The per-session bounds a daemon admits a registration under. */
export interface SessionRegistrationLimits {
  /** Most files one registration may list. */
  maxFiles: number;
  /** Most resources one review catalog may declare. */
  maxCatalogResources: number;
  /** Largest register message, which travels as one websocket frame. */
  maxMessageBytes: number;
  /** Most bytes the daemon retains for one session's registration and snapshot. */
  maxRetainedBytes: number;
}

/** The bounds a Hunk session daemon enforces; tests pass smaller ones. */
export const HUNK_SESSION_REGISTRATION_LIMITS: Readonly<SessionRegistrationLimits> = Object.freeze({
  maxFiles: MAX_REGISTRATION_FILES,
  maxCatalogResources: MAX_HUNK_REVIEW_CATALOG_RESOURCES,
  maxMessageBytes: DEFAULT_SESSION_BROKER_LIMITS.maxWsMessageBytes,
  maxRetainedBytes: DEFAULT_SESSION_BROKER_LIMITS.maxRetainedSessionBytes,
});

/** Whether a daemon will hold one registration, and if not, how far over it is. */
export type SessionRegistrationAdmission =
  | { ok: true }
  | {
      ok: false;
      /** Files the review lists. */
      fileCount: number;
      /** Roughly how many files of the same size the daemon would hold, rounded down. */
      estimatedMaxFiles: number;
    };

/** Round a positive count down to two significant digits, so an estimate does not read as exact. */
function roundDownEstimate(count: number) {
  if (count < 100) return Math.max(0, Math.floor(count));
  const step = 10 ** (Math.floor(Math.log10(count)) - 1);
  return Math.floor(count / step) * step;
}

/**
 * Measure one registration and its snapshot against the daemon's per-session bounds.
 *
 * Every bound grows with the number of files, so the estimate scales the file count by the
 * bound it overshoots most.
 */
export function assessSessionRegistration(
  registration: HunkSessionRegistration,
  snapshot: HunkSessionSnapshot,
  limits: SessionRegistrationLimits = HUNK_SESSION_REGISTRATION_LIMITS,
): SessionRegistrationAdmission {
  const fileCount = registration.info.files.length;
  const message: SessionClientMessage = { type: "register", registration, snapshot };
  const overshoot = Math.max(
    fileCount / limits.maxFiles,
    (registration.info.reviewCatalog?.resources.length ?? 0) / limits.maxCatalogResources,
    utf8ByteLength(JSON.stringify(message)) / limits.maxMessageBytes,
    measureRetainedSessionBytes(registration, snapshot) / limits.maxRetainedBytes,
  );
  if (overshoot <= 1) return { ok: true };
  return { ok: false, fileCount, estimatedMaxFiles: roundDownEstimate(fileCount / overshoot) };
}

/** Explain a refused registration in one sentence pair: the cause, then the remedy. */
export function describeOversizedSessionRegistration(
  admission: Extract<SessionRegistrationAdmission, { ok: false }>,
) {
  const count = (value: number) => value.toLocaleString("en-US");
  const files = (value: number) => `${count(value)} file${value === 1 ? "" : "s"}`;
  const capacity =
    admission.estimatedMaxFiles > 0
      ? ` (about ${files(admission.estimatedMaxFiles)} like these)`
      : "";
  return `This review has ${files(admission.fileCount)}, more than the session daemon can hold${capacity}. Narrow it to fewer files with \`-- <pathspec>\`.`;
}
