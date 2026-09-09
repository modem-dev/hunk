/**
 * The capability one live session's review is served under.
 *
 * A session that publishes a review can be read over HTTP by whoever holds its capability,
 * so the capability is minted here — in the process that owns the review — and only its
 * digest is published to the daemon. The clear token never leaves this process except in
 * the URL fragment a person is handed, which means neither the daemon's memory, its
 * registration payloads, nor any request log can produce a working one.
 *
 * One capability per process rather than per generation: it authorizes access to *this
 * session's* review, and a reload replaces the review, not the session. A link a reviewer
 * already opened therefore keeps working across reloads, which is the behavior a review
 * that outlives its first minute needs.
 *
 * The grammar — token shape, fragment key, URL layout — is the shared browser-safe
 * contract (`packages/hunk/src/session/reviewHttpProtocol.ts`); this module only supplies the randomness
 * and the hashing that a platform has to provide.
 */
import { randomBytes } from "node:crypto";
import { REVIEW_CAPABILITY_ENTROPY_BYTES, reviewUrl } from "../../session/reviewHttpProtocol";
import { nodeReviewDigest } from "../../core/reviewDigest";

/** One capability: the secret its holder presents, and the digest the daemon verifies against. */
export interface ReviewCapability {
  token: string;
  digest: string;
}

/** Mint one capability from the platform's cryptographic randomness. */
export function createReviewCapability(): ReviewCapability {
  const token = randomBytes(REVIEW_CAPABILITY_ENTROPY_BYTES).toString("base64url");
  return { token, digest: nodeReviewDigest(new TextEncoder().encode(token)) };
}

let processCapability: ReviewCapability | undefined;

/**
 * This process's capability, minted on first use.
 *
 * Lazy so a Hunk run that never registers with a daemon never mints one, and cached so the
 * registration the session publishes and the URL it prints describe the same secret.
 */
export function reviewProcessCapability(): ReviewCapability {
  processCapability ??= createReviewCapability();
  return processCapability;
}

/** The URL a person opens to review this session in a browser. */
export function reviewProcessUrl(origin: string, sessionId: string) {
  return reviewUrl(origin, sessionId, reviewProcessCapability().token);
}
