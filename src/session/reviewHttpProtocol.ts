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
 * the edges (`src/app/review/capability.ts` on the session side). This module stays
 * browser-safe so the client that reads the fragment imports the same grammar the session
 * wrote it with.
 */
import { HUNK_REVIEW_PROTOCOL_VERSION, MAX_HUNK_REVIEW_IDENTIFIER_BYTES } from "./reviewProtocol";
import type { HunkReviewResourceCatalogV1 } from "./reviewProtocol";
import type { ReviewPublicationAddress } from "../core/review/generationOrder";
import { isReviewSha256Digest, utf8ByteLength } from "../core/review/validation";
import { reviewErrorMessage, type HunkReviewClientErrorCodeV1 } from "./reviewErrorCatalog";

export type { HunkReviewClientErrorCodeV1 } from "./reviewErrorCatalog";

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

/**
 * Headers a resource response states its whole-resource measurement in.
 *
 * A published catalog describes resources the producer has not measured yet — measuring
 * one means producing its bytes — so a reader cannot get the size and digest to verify a
 * read from the catalog it addressed the read with. They travel with the bytes instead,
 * on every window of them, which is what lets a client hold a multi-window read to one
 * measurement through the shared `ReviewChunkAssembler` rather than trusting whatever
 * arrives (`docs/browser-review-seam-audit.md`, C2).
 *
 * Deliberately about the whole resource, never about the slice: `content-range` and
 * `content-length` already describe the slice, and a per-window digest would let a
 * truncated read verify.
 */
export const HUNK_REVIEW_CONTENT_SIZE_HEADER = "hunk-review-content-size";
export const HUNK_REVIEW_CONTENT_DIGEST_HEADER = "hunk-review-content-digest";

/** One resource's whole-content measurement, as the surface states and a reader parses it. */
export interface HunkReviewContentMeasurement {
  byteLength: number;
  digest: string;
}

/** Render one measurement as the headers every window of a resource carries. */
export function reviewContentMeasurementHeaders({
  byteLength,
  digest,
}: HunkReviewContentMeasurement): Record<string, string> {
  return {
    [HUNK_REVIEW_CONTENT_SIZE_HEADER]: String(byteLength),
    [HUNK_REVIEW_CONTENT_DIGEST_HEADER]: digest,
  };
}

/**
 * Read one measurement back off a response, or nothing when it does not state one.
 *
 * Validated rather than trusted: the digest must be in the canonical form the shared
 * validator accepts, so a reader cannot adopt a measurement it would later be unable to
 * compare against (D5).
 */
export function parseReviewContentMeasurementHeaders(
  headers: Headers,
): HunkReviewContentMeasurement | undefined {
  const digest = headers.get(HUNK_REVIEW_CONTENT_DIGEST_HEADER);
  const size = headers.get(HUNK_REVIEW_CONTENT_SIZE_HEADER);
  // Read as a decimal integer rather than through `Number`, which reads an absent header
  // as zero — a size a zero-length resource legitimately has.
  const byteLength = size !== null && /^\d{1,15}$/.test(size) ? Number(size) : Number.NaN;
  return isReviewSha256Digest(digest) && Number.isSafeInteger(byteLength)
    ? { byteLength, digest }
    : undefined;
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

/** One refusal, in the shape every review route answers with. */
export interface HunkReviewHttpFailureV1 {
  ok: false;
  code: HunkReviewClientErrorCodeV1;
  message: string;
  /** What the session is serving now, when the failure was about being out of date. */
  currentGeneration?: string;
}

/**
 * HTTP status each failure is reported with.
 *
 * Total over the code union, so a code added to any tier's vocabulary cannot reach this
 * surface without someone deciding what it means to a client. It lives with the rest of
 * the HTTP contract rather than in the server, because a client reading a body-less
 * refusal has to answer the same question in the other direction.
 */
export const REVIEW_ERROR_STATUS: Record<HunkReviewClientErrorCodeV1, number> = {
  "stale-generation": 409,
  "invalid-request": 400,
  "unsupported-action": 400,
  "file-not-found": 404,
  "hunk-not-found": 404,
  "gap-not-found": 404,
  "draft-missing": 409,
  "note-not-found": 404,
  "missing-fact": 400,
  "unknown-resource": 404,
  "resource-unavailable": 502,
  "resource-too-large": 413,
  "resource-integrity": 502,
  "invalid-range": 416,
  unauthorized: 401,
  "no-publication": 409,
  "payload-too-large": 413,
  "method-not-allowed": 405,
  "unsupported-media-type": 415,
  "forbidden-origin": 403,
  "too-many-streams": 503,
};

/** Statuses exactly one code claims, derived from the table rather than listed again. */
const REVIEW_ERROR_STATUS_INVERSE: ReadonlyMap<number, HunkReviewClientErrorCodeV1> = (() => {
  const claims = new Map<number, HunkReviewClientErrorCodeV1[]>();
  for (const [code, status] of Object.entries(REVIEW_ERROR_STATUS) as Array<
    [HunkReviewClientErrorCodeV1, number]
  >) {
    claims.set(status, [...(claims.get(status) ?? []), code]);
  }
  return new Map(
    [...claims].flatMap(([status, codes]) => (codes.length === 1 ? [[status, codes[0]!]] : [])),
  );
})();

/**
 * The one code a status stands for, when the table gives it only one.
 *
 * A route that refuses without a body — an unsatisfiable range is answered with a bare 416
 * — leaves a client nothing but the status to read. Several codes share 400, 404, and 409,
 * and picking one of those would be inventing an answer, so this reports only where the
 * table is unambiguous and leaves the caller to say what an ambiguous status means to it.
 */
export function reviewErrorCodeForStatus(status: number): HunkReviewClientErrorCodeV1 | undefined {
  return REVIEW_ERROR_STATUS_INVERSE.get(status);
}

/**
 * Build one refusal in the shape every review route answers with.
 *
 * The message comes from the shared catalog unless a tier supplied a more specific one, so
 * no consumer — the surface answering, or a client rebuilding what it was told — has to
 * invent wording for a code (`docs/browser-review-seam-audit.md`, G4).
 */
export function reviewHttpFailure(
  code: HunkReviewClientErrorCodeV1,
  details: { message?: string; currentGeneration?: string } = {},
): HunkReviewHttpFailureV1 {
  return {
    ok: false,
    code,
    message: details.message ?? reviewErrorMessage(code),
    ...(details.currentGeneration ? { currentGeneration: details.currentGeneration } : {}),
  };
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
