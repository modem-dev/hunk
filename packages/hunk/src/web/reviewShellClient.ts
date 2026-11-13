/**
 * Loads what the minimal browser review shell shows: whether the session answers, how many
 * files its review has, and the first file's patch.
 *
 * Opening the review URL is the only trigger. The page path names the session and the URL
 * fragment carries the capability; this module presents that capability in the review API's
 * header and nowhere else, so it never reaches a path, a query string, a log, or storage.
 * Every route, header name, and wire shape comes from the browser-safe session modules, and
 * every failure a person sees is a sentence from the shared error catalog.
 *
 * This is the M3 shell, not the client: no event stream, no mirror, no reconnects. The real
 * transport (`apiClient`, `ReviewChunkAssembler`, the SSE reader) arrives with the read-only
 * client and replaces this module.
 */
import type { ReviewResourceDescriptorV1 } from "../core/review/resources";
import { isReviewSha256Digest, reviewDigestsEqual } from "../core/review/validation";
import { REVIEW_ERROR_CATALOG, reviewErrorMessage } from "../session/reviewErrorCatalog";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewCapabilityFragment,
  parseReviewPagePath,
  reviewHttpPath,
  type HunkReviewClientErrorCodeV1,
  type HunkReviewHttpRoute,
} from "../session/reviewHttpProtocol";
import {
  parseHunkReviewPublicationAddress,
  parseHunkReviewResourceCatalog,
} from "../session/reviewProtocol";

/** What the shell renders once a load settles. */
export type ReviewShellResult =
  | { status: "failed"; message: string }
  | {
      status: "connected";
      sessionId: string;
      fileCount: number;
      /** The first file's patch, or nothing for an empty review. */
      firstPatch?: string;
    };

/** A request refusal carrying the shared message for its code. */
class ReviewShellError extends Error {}

/** Fallback for failures that arrive without a code this build knows. */
const UNREADABLE_RESPONSE_MESSAGE = "The Hunk session sent a response this page cannot read.";

/** Shown when the daemon cannot be reached at all, which no review failure code describes. */
const UNREACHABLE_MESSAGE =
  "The Hunk session daemon did not answer. Check that the review is still running, then reload.";

/** Return whether one value is a failure code the shared catalog documents. */
function isClientErrorCode(value: unknown): value is HunkReviewClientErrorCodeV1 {
  return typeof value === "string" && Object.hasOwn(REVIEW_ERROR_CATALOG, value);
}

/** Turn one refused response into the catalog sentence for its code. */
async function refusal(response: Response): Promise<ReviewShellError> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (isClientErrorCode(body.code)) {
      return new ReviewShellError(reviewErrorMessage(body.code));
    }
  } catch {
    // Not a review failure body; fall through to the generic sentence.
  }
  return new ReviewShellError(UNREADABLE_RESPONSE_MESSAGE);
}

/** Request one review API route with the capability presented in its header. */
function requestRoute(route: HunkReviewHttpRoute, capability: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set(HUNK_REVIEW_CAPABILITY_HEADER, capability);
  return fetch(reviewHttpPath(route), {
    headers: requestHeaders,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
}

/** Return the total size a `content-range` header reports, if it reports one. */
function rangeTotal(header: string | null) {
  const match = header ? /\/(\d+)$/.exec(header) : null;
  return match ? Number(match[1]) : undefined;
}

/** Hex SHA-256 of some bytes, with the browser's Web Crypto. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Read one whole resource, window by window, and check it against its published digest.
 *
 * The server caps each response at the shared chunk size, so a long patch takes several
 * ranged reads.
 */
async function readResource(
  sessionId: string,
  capability: string,
  descriptor: ReviewResourceDescriptorV1,
): Promise<string> {
  const route: HunkReviewHttpRoute = {
    kind: "resource",
    sessionId,
    generation: descriptor.generation,
    resourceId: descriptor.id,
  };
  const parts: Uint8Array[] = [];
  let received = 0;
  let total: number | undefined;

  do {
    const response = await requestRoute(route, capability, { range: `bytes=${received}-` });
    if (!response.ok) {
      throw await refusal(response);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    parts.push(bytes);
    received += bytes.byteLength;
    total = response.status === 206 ? rangeTotal(response.headers.get("content-range")) : received;
    if (bytes.byteLength === 0 && total !== undefined && received < total) {
      throw new ReviewShellError(UNREADABLE_RESPONSE_MESSAGE);
    }
  } while (total !== undefined && received < total);

  const content = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    content.set(part, offset);
    offset += part.byteLength;
  }

  if (isReviewSha256Digest(descriptor.digest)) {
    if (!reviewDigestsEqual(await sha256Hex(content), descriptor.digest)) {
      throw new ReviewShellError(reviewErrorMessage("resource-integrity"));
    }
  }
  return new TextDecoder().decode(content);
}

/**
 * Load the shell's view of the review this page was opened for.
 *
 * `location` is the page's own address: the path names the session and the fragment holds
 * the capability. Never throws; every failure becomes a catalog sentence.
 */
export async function loadReviewShell(location: {
  pathname: string;
  hash: string;
}): Promise<ReviewShellResult> {
  const route = parseReviewPagePath(location.pathname);
  const capability = parseReviewCapabilityFragment(location.hash);
  if (route?.kind !== "document" || !capability) {
    return { status: "failed", message: reviewErrorMessage("unauthorized") };
  }
  const { sessionId } = route;

  try {
    const response = await requestRoute({ kind: "publication", sessionId }, capability);
    if (!response.ok) {
      throw await refusal(response);
    }
    const body = (await response.json()) as { publication?: unknown; catalog?: unknown };
    const address = parseHunkReviewPublicationAddress(body.publication);
    const catalog = parseHunkReviewResourceCatalog(body.catalog);
    if (!address || !catalog) {
      throw new ReviewShellError(UNREADABLE_RESPONSE_MESSAGE);
    }

    // Every file offers exactly one canonical form, in review order, so they count the files
    // and the first one names the file the shell previews.
    const files = catalog.resources.filter((resource) => resource.kind === "canonical-file");
    const firstFileKey = files[0]?.fileKey;
    const firstPatch = catalog.resources.find(
      (resource) => resource.kind === "patch" && resource.fileKey === firstFileKey,
    );

    return {
      status: "connected",
      sessionId,
      fileCount: files.length,
      firstPatch: firstPatch ? await readResource(sessionId, capability, firstPatch) : undefined,
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof ReviewShellError ? error.message : UNREACHABLE_MESSAGE,
    };
  }
}
