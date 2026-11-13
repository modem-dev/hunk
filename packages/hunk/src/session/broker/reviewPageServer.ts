/**
 * Serves the browser review page: one static document for any session, and the hashed
 * scripts and styles it loads.
 *
 * A person opens `/review/<session>/#capability=…`. The document request carries no secret
 * and the response carries no review data — the script on the page reads the capability
 * from `location.hash` and asks the capability-gated `/review-api` surface
 * (`browserReviewServer.ts`) for everything else. That is why both routes here are
 * unauthenticated, and why they must stay free of anything session-specific:
 *
 * - The document is byte-identical for every session id, existing or not, so the page
 *   route can never be used to learn which sessions are live.
 * - Assets are looked up by name in the build manifest (`reviewPageAssets.ts`), never by
 *   path, so traversal is not a matter of careful string handling but of there being no
 *   filesystem path to traverse to.
 *
 * The daemon mounts this behind its Host and Origin checks, after the review API, and it
 * declines every path outside its two prefixes so existing routes keep their behavior.
 */
import {
  HUNK_REVIEW_ASSET_PATH_PREFIX,
  HUNK_REVIEW_PAGE_PATH_PREFIX,
  parseReviewPagePath,
} from "../reviewHttpProtocol";
import {
  loadReviewPageAssets,
  type ReviewPageAssets,
  type ReviewPageFile,
} from "./reviewPageAssets";

/**
 * Content security policy for the page document.
 *
 * The strictest policy Pierre's renderers work under (`docs/web-review-client.md` records
 * the measurements): everything defaults to nothing, scripts and fetches come only from this
 * origin, and styles additionally allow inline because Pierre writes syntax colors as
 * `style` attributes and theme rules as `<style>` elements inside its shadow roots.
 */
export const REVIEW_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Policy for every non-document response: nothing a browser renders should load anything. */
const LOCKED_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Hashed asset names change whenever their content does, so a cached copy never goes stale. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Headers every page-surface response carries. */
const PAGE_SECURITY_HEADERS: Record<string, string> = {
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export interface ReviewPageServerOptions {
  /** Load the page build; defaults to the build this distribution carries. */
  loadAssets?: () => Promise<ReviewPageAssets | undefined>;
}

/** Return whether one path falls under the page surface's prefixes. */
function isPageSurfacePath(pathname: string) {
  return [HUNK_REVIEW_PAGE_PATH_PREFIX, HUNK_REVIEW_ASSET_PATH_PREFIX].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Return whether the client will take a gzip-encoded body. */
function acceptsGzip(request: Request) {
  const header = request.headers.get("accept-encoding");
  if (!header) {
    return false;
  }
  return header.split(",").some((part) => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";");
    if (coding?.trim() !== "gzip") {
      return false;
    }
    const quality = parameters.map((parameter) => parameter.trim()).find((p) => p.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

/** Serve the review page document and its assets. */
export class ReviewPageServer {
  private readonly loadAssets: () => Promise<ReviewPageAssets | undefined>;

  constructor(options: ReviewPageServerOptions = {}) {
    this.loadAssets = options.loadAssets ?? loadReviewPageAssets;
  }

  /**
   * Answer one request, or decline it as not a page route.
   *
   * `undefined` means "not mine", so the daemon's other routes and its 404 keep working.
   */
  async handle(request: Request): Promise<Response | undefined> {
    const { pathname } = new URL(request.url);
    if (!isPageSurfacePath(pathname)) {
      return undefined;
    }

    const route = parseReviewPagePath(pathname);
    if (!route) {
      return this.text(404, "Not found.");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return this.text(405, "Method not allowed.", { allow: "GET, HEAD" });
    }

    const assets = await this.loadAssets();
    if (!assets) {
      return this.text(503, "The browser review page is not available in this Hunk build.");
    }

    if (route.kind === "document") {
      // The session id is deliberately unused: every session gets the same bytes.
      return this.file(request, assets.document(), {
        "cache-control": "no-store",
        "content-security-policy": REVIEW_PAGE_CONTENT_SECURITY_POLICY,
        "cross-origin-opener-policy": "same-origin",
      });
    }

    const asset = assets.asset(route.name);
    return asset
      ? this.file(request, asset, { "cache-control": IMMUTABLE_CACHE_CONTROL })
      : this.text(404, "Not found.");
  }

  /** Respond with one file, gzip-encoded when it is stored that way and the client accepts it. */
  private async file(request: Request, file: ReviewPageFile, extra: Record<string, string>) {
    const headers = this.headers({
      "content-security-policy": LOCKED_CONTENT_SECURITY_POLICY,
      ...extra,
      "content-type": file.contentType,
    });

    let body = file.body;
    if (file.gzip) {
      headers.set("vary", "accept-encoding");
      if (acceptsGzip(request)) {
        headers.set("content-encoding", "gzip");
      } else {
        const inflated = Bun.gunzipSync(new Uint8Array(await file.body.arrayBuffer()));
        body = new Blob([inflated as Uint8Array<ArrayBuffer>]);
      }
    }

    headers.set("content-length", String(body.size));
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  }

  /** Respond with one short plain-text status. */
  private text(status: number, message: string, extra: Record<string, string> = {}) {
    return new Response(`${message}\n`, {
      status,
      headers: this.headers({
        "cache-control": "no-store",
        "content-security-policy": LOCKED_CONTENT_SECURITY_POLICY,
        "content-type": "text/plain; charset=utf-8",
        ...extra,
      }),
    });
  }

  private headers(extra: Record<string, string>) {
    const headers = new Headers(PAGE_SECURITY_HEADERS);
    for (const [key, value] of Object.entries(extra)) {
      headers.set(key, value);
    }
    return headers;
  }
}
