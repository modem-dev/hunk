/**
 * How a review is addressed and authorized over HTTP.
 *
 * The session daemon can serve one live review to a local client: where its routes are,
 * how a caller proves it may read them, and how the whole thing is expressed as one URL a
 * person can open. Both ends need those facts, so they are stated once here rather than
 * spelled out in a server and re-derived by a client — the failure mode the audit recorded
 * for the event contract and for wire constants generally
 * (`docs/browser-review-seam-audit.md`, C4/D5).
 *
 * Two decisions this module encodes, both security-shaped:
 *
 * - **The capability travels in the URL fragment and is presented in a header.** A
 *   fragment is never sent to a server, never written to an access log, and never leaks
 *   through `Referer`; a header is not something a cross-origin page can attach, so the
 *   surface needs no CSRF machinery and grants no CORS. The token therefore appears in no
 *   path and no query string, on either end.
 * - **The daemon holds a digest, never the token.** The session that owns the review mints
 *   the capability and publishes only its SHA-256; the daemon compares digests. A daemon
 *   memory dump, a registration log, or a mirrored snapshot cannot hand anyone a working
 *   capability.
 *
 * Nothing here computes: minting a token and hashing one need a platform, so those live at
 * the edges (`packages/hunk/src/app/review/capability.ts` on the session side). This module stays
 * browser-safe so the client that reads the fragment imports the same grammar the session
 * wrote it with.
 */
import { HUNK_REVIEW_PROTOCOL_VERSION, MAX_HUNK_REVIEW_IDENTIFIER_BYTES } from "./reviewProtocol";
import type { HunkReviewFailureCodeV1, HunkReviewResourceCatalogV1 } from "./reviewProtocol";
import type { ReviewPublicationAddress } from "../core/review/generationOrder";
import { utf8ByteLength } from "../core/review/validation";

/** Path every review route hangs from, so a client never assembles route strings itself. */
export const HUNK_REVIEW_HTTP_PATH_PREFIX = "/review-api";

/**
 * Path the browser review page will be served from.
 *
 * Separate from the API prefix because they are different things to a browser: the page is
 * a document that may be bookmarked and reloaded, the API is what the script on it calls.
 * Phase 6 serves the document; the path is declared now because the review URL — the one
 * artifact a person handles — is this path plus the capability fragment.
 */
export const HUNK_REVIEW_PAGE_PATH_PREFIX = "/review";

/**
 * Header one caller presents its capability in.
 *
 * Lowercase because that is how every HTTP/2 implementation and `Headers` lookup spells
 * it; a caller may send any case.
 */
export const HUNK_REVIEW_CAPABILITY_HEADER = "hunk-review-capability";

/** Fragment parameter the review URL carries the capability in. */
export const HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY = "capability";

/** Entropy behind one capability. 256 bits, so guessing is not a threat model. */
export const REVIEW_CAPABILITY_ENTROPY_BYTES = 32;

/**
 * Length of the base64url form of one capability.
 *
 * Derived from the entropy rather than written down, so changing the entropy cannot leave
 * a validator accepting the old width.
 */
export const REVIEW_CAPABILITY_TOKEN_LENGTH = Math.ceil((REVIEW_CAPABILITY_ENTROPY_BYTES * 8) / 6);

/** Whether one value is a capability token in the form this surface issues. */
export function isReviewCapabilityToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === REVIEW_CAPABILITY_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** One route on the review surface, named by what it serves rather than by its path. */
export type HunkReviewHttpRoute =
  | { kind: "publication"; sessionId: string }
  | { kind: "events"; sessionId: string }
  | { kind: "actions"; sessionId: string }
  | { kind: "resource"; sessionId: string; generation: string; resourceId: string };

/** Whether one path segment is a usable identifier: non-empty, bounded, and not a traversal. */
function isPathIdentifier(value: string) {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_HUNK_REVIEW_IDENTIFIER_BYTES &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** Build the path one route is served at, with every identifier percent-encoded. */
export function reviewHttpPath(route: HunkReviewHttpRoute): string {
  const base = `${HUNK_REVIEW_HTTP_PATH_PREFIX}/${encodeURIComponent(route.sessionId)}`;
  if (route.kind === "resource") {
    return `${base}/resources/${encodeURIComponent(route.generation)}/${encodeURIComponent(route.resourceId)}`;
  }
  return `${base}/${route.kind}`;
}

/** Decode one path segment, refusing anything that is not a bounded plain identifier. */
function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_HUNK_REVIEW_IDENTIFIER_BYTES * 3) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return isPathIdentifier(decoded) ? decoded : undefined;
}

/**
 * Parse one request path into the route it names.
 *
 * Strict by construction: a path under the review prefix that does not match a route is
 * `undefined` rather than a partially understood request, so the server answers "not a
 * review route" instead of guessing which session was meant.
 */
export function parseReviewHttpPath(pathname: string): HunkReviewHttpRoute | undefined {
  const parts = pathname.split("/");
  if (parts[0] !== "" || `/${parts[1]}` !== HUNK_REVIEW_HTTP_PATH_PREFIX) {
    return undefined;
  }
  const sessionId = decodeSegment(parts[2]);
  if (!sessionId) {
    return undefined;
  }
  if (parts.length === 4) {
    const kind = parts[3];
    return kind === "publication" || kind === "events" || kind === "actions"
      ? { kind, sessionId }
      : undefined;
  }
  if (parts.length === 6 && parts[3] === "resources") {
    const generation = decodeSegment(parts[4]);
    const resourceId = decodeSegment(parts[5]);
    return generation && resourceId
      ? { kind: "resource", sessionId, generation, resourceId }
      : undefined;
  }
  return undefined;
}

/** Path the review page for one session is served at. */
export function reviewPagePath(sessionId: string): string {
  return `${HUNK_REVIEW_PAGE_PATH_PREFIX}/${encodeURIComponent(sessionId)}/`;
}

/**
 * Build the URL a person opens to review one session in a browser.
 *
 * The capability is the whole fragment payload, so the request that fetches the page
 * carries no secret at all and the client reads it out of `location.hash`.
 */
export function reviewUrl(origin: string, sessionId: string, capability: string): string {
  const url = new URL(reviewPagePath(sessionId), origin);
  url.hash = new URLSearchParams({
    [HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY]: capability,
  }).toString();
  return url.toString();
}

/** Read one capability back out of a URL fragment, with or without its leading `#`. */
export function parseReviewCapabilityFragment(fragment: string): string | undefined {
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  const capability = params.get(HUNK_REVIEW_CAPABILITY_FRAGMENT_KEY);
  return isReviewCapabilityToken(capability) ? capability : undefined;
}

/**
 * Why one review request failed at the transport rather than at the review.
 *
 * Beside the producer's vocabulary rather than mixed into it: these are things that go
 * wrong before an action or a read ever reaches the session — the caller was not
 * authorized, addressed a session nobody is serving, or sent something the surface will
 * not carry.
 */
export type HunkReviewTransportErrorCode =
  /**
   * No capability, or one that does not match the session addressed.
   *
   * Also the answer for a session nobody is serving: telling a caller that a session does
   * not exist is telling it which sessions do.
   */
  | "unauthorized"
  /** The session is registered but publishes no review to serve. */
  | "no-publication"
  /** The request body is larger than this surface accepts. */
  | "payload-too-large"
  /** The route exists but not for this method. */
  | "method-not-allowed"
  /** The body was not sent as JSON. */
  | "unsupported-media-type"
  /** The Host or Origin does not name this local surface. */
  | "forbidden-origin"
  /** The action names a type this build's vocabulary does not contain. */
  | "unsupported-action"
  /** The surface is already serving as many event streams as it will. */
  | "too-many-streams";

/**
 * Every code a review client can be told, from any tier.
 *
 * Composed from the producer's vocabulary and the transport's rather than restated as a
 * third list, which is the same rule `HunkReviewFailureCodeV1` follows one level down.
 */
export type HunkReviewClientErrorCodeV1 = HunkReviewFailureCodeV1 | HunkReviewTransportErrorCode;

/** One refusal, in the shape every review route answers with. */
export interface HunkReviewHttpFailureV1 {
  ok: false;
  code: HunkReviewClientErrorCodeV1;
  message: string;
  /** What the session is serving now, when the failure was about being out of date. */
  currentGeneration?: string;
}

/**
 * One publication as the surface serves it: where the review is, and what it offers there.
 *
 * Deliberately not a copy of the review itself. A publication is a position plus a
 * resource catalog, and the content behind it — patches, canonical files, source — is read
 * through the one bounded, digest-verified resource path rather than inlined here, so the
 * surface has no second serialization of a review to keep in step with the model.
 */
export interface HunkReviewPublicationBodyV1 {
  protocolVersion: typeof HUNK_REVIEW_PROTOCOL_VERSION;
  sessionId: string;
  publication: ReviewPublicationAddress;
  catalog: HunkReviewResourceCatalogV1;
}
