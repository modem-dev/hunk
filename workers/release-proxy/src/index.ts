const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/modem-dev/hunk/releases/latest";
const RELEASE_ROUTE = "/v1/curl/latest";
const CACHE_CONTROL = "public, max-age=300";
const ERROR_CACHE_CONTROL = "no-store";
const UPSTREAM_TIMEOUT_MS = 5_000;

const REQUEST_SOURCES = ["install", "startup", "update-check", "update"] as const;
type RequestSource = (typeof REQUEST_SOURCES)[number] | "unknown";

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ReleaseProxyDeps {
  fetchImpl?: FetchImpl;
  cache?: WorkerCache;
  log?: (entry: string) => void;
  upstreamTimeoutMs?: number;
}

/** Return a bounded request source suitable for aggregate release-check logs. */
function requestSource(request: Request): RequestSource {
  const candidate = request.headers.get("x-hunk-request-source");
  return REQUEST_SOURCES.find((source) => source === candidate) ?? "unknown";
}

/** Return a normalized Hunk version without admitting arbitrary values into structured logs. */
function currentVersion(request: Request) {
  const candidate = request.headers.get("x-hunk-current-version");
  return candidate && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(candidate) ? candidate : "unknown";
}

/** Read the stable version from GitHub's latest-release payload. */
function stableVersion(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  const tagName = (payload as Record<string, unknown>).tag_name;
  if (typeof tagName !== "string") {
    return undefined;
  }

  const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

/** Build one JSON response with explicit edge and client caching policy. */
function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": status === 200 ? CACHE_CONTROL : ERROR_CACHE_CONTROL,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Resolve Cloudflare's default cache without requiring it in direct unit tests. */
function defaultWorkerCache() {
  return (
    globalThis as typeof globalThis & {
      caches?: { default?: WorkerCache };
    }
  ).caches?.default;
}

/** Serve normalized curl release metadata while logging only bounded aggregate dimensions. */
export function createReleaseProxyHandler(deps: ReleaseProxyDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = deps.cache ?? defaultWorkerCache();
  const log = deps.log ?? console.log;
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return async (request: Request, _env: unknown, ctx: WorkerExecutionContext) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== RELEASE_ROUTE) {
      return jsonResponse({ error: "not_found" }, 404);
    }

    log(
      JSON.stringify({
        event: "release_check",
        source: requestSource(request),
        currentVersion: currentVersion(request),
      }),
    );

    const cacheKey = new Request(`${url.origin}${RELEASE_ROUTE}`);
    const cached = await cache?.match(cacheKey);
    if (cached) {
      return cached;
    }

    let upstream: Response;
    let payload: unknown;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      upstream = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "hunk-release-proxy",
        },
        signal: controller.signal,
      });
      if (!upstream.ok) {
        return jsonResponse({ error: "upstream_unavailable" }, 502);
      }

      try {
        payload = await upstream.json();
      } catch {
        return jsonResponse({ error: "invalid_upstream_response" }, 502);
      }
    } catch {
      return jsonResponse({ error: "upstream_unavailable" }, 502);
    } finally {
      clearTimeout(timeout);
    }

    const version = stableVersion(payload);
    if (!version) {
      return jsonResponse({ error: "invalid_upstream_response" }, 502);
    }

    const response = jsonResponse({ version });
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  };
}

export default {
  fetch: createReleaseProxyHandler(),
};
