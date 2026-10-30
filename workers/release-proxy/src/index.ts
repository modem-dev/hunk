const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/modem-dev/hunk/releases/latest";
const RELEASE_ROUTE = "/v1/curl/latest";
const RELEASE_METADATA_KEY = "latest-stable-release";
const CLIENT_CACHE_CONTROL = "no-store";
const UPSTREAM_TIMEOUT_MS = 5_000;
const METADATA_HEARTBEAT_MS = 60 * 60 * 1_000;
const MAX_METADATA_AGE_MS = 6 * 60 * 60 * 1_000;
const MAX_VERSION_LENGTH = 64;

const REQUEST_SOURCES = ["install", "startup", "update-check", "update"] as const;
type RequestSource = (typeof REQUEST_SOURCES)[number] | "unknown";

interface ReleaseMetadata {
  version: string;
  checkedAt: number;
}

interface ReleaseMetadataNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface ReleaseProxyEnv {
  RELEASE_METADATA: ReleaseMetadataNamespace;
  GITHUB_TOKEN?: string;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ReleaseProxyDeps {
  fetchImpl?: FetchImpl;
  log?: (entry: string) => void;
  now?: () => number;
  upstreamTimeoutMs?: number;
}

type RefreshFailureReason =
  | "upstream_unavailable"
  | "invalid_upstream_response"
  | "storage_unavailable";

type RefreshResult =
  | { status: "updated" | "unchanged"; version: string }
  | { status: "failed"; reason: RefreshFailureReason; upstreamStatus?: number };

/** Return whether a value is one bounded stable Hunk version. */
function isStableVersion(value: string) {
  return value.length <= MAX_VERSION_LENGTH && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value);
}

/** Return a bounded request source suitable for aggregate release-check logs. */
function requestSource(request: Request): RequestSource {
  const candidate = request.headers.get("x-hunk-request-source");
  return REQUEST_SOURCES.find((source) => source === candidate) ?? "unknown";
}

/** Return a normalized Hunk version without admitting arbitrary values into structured logs. */
function currentVersion(request: Request) {
  const candidate = request.headers.get("x-hunk-current-version");
  return candidate &&
    candidate.length <= MAX_VERSION_LENGTH &&
    /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-beta\.\d{1,9})?$/.test(candidate)
    ? candidate
    : "unknown";
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
  return isStableVersion(version) ? version : undefined;
}

/** Parse one validated release record from global storage. */
function releaseMetadata(value: string | null): ReleaseMetadata | undefined {
  if (!value) return undefined;

  try {
    const payload = JSON.parse(value) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if (
      typeof record.version !== "string" ||
      !isStableVersion(record.version) ||
      typeof record.checkedAt !== "number" ||
      !Number.isSafeInteger(record.checkedAt) ||
      record.checkedAt < 0
    ) {
      return undefined;
    }
    return { version: record.version, checkedAt: record.checkedAt };
  } catch {
    return undefined;
  }
}

/** Return whether stored metadata is recent enough to suppress direct-GitHub fallback. */
function isFreshMetadata(metadata: ReleaseMetadata, now: number) {
  const age = now - metadata.checkedAt;
  return age >= 0 && age <= MAX_METADATA_AGE_MS;
}

/** Build one JSON response that clients and outer caches must not retain. */
function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": CLIENT_CACHE_CONTROL,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Fetch, validate, and persist the latest release without replacing last-known good metadata. */
async function refreshReleaseVersion(
  env: ReleaseProxyEnv,
  deps: Required<ReleaseProxyDeps>,
): Promise<RefreshResult> {
  let previous: ReleaseMetadata | undefined;
  try {
    previous = releaseMetadata(await env.RELEASE_METADATA.get(RELEASE_METADATA_KEY));
  } catch {
    return { status: "failed", reason: "storage_unavailable" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.upstreamTimeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "hunk-release-proxy",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }

    const fetchImpl = deps.fetchImpl;
    const upstream = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
      headers,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return {
        status: "failed",
        reason: "upstream_unavailable",
        upstreamStatus: upstream.status,
      };
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return {
        status: "failed",
        reason: controller.signal.aborted ? "upstream_unavailable" : "invalid_upstream_response",
      };
    }

    const version = stableVersion(payload);
    if (!version) {
      return { status: "failed", reason: "invalid_upstream_response" };
    }

    const now = deps.now();
    if (
      previous?.version === version &&
      now >= previous.checkedAt &&
      now - previous.checkedAt < METADATA_HEARTBEAT_MS
    ) {
      return { status: "unchanged", version };
    }

    try {
      await env.RELEASE_METADATA.put(
        RELEASE_METADATA_KEY,
        JSON.stringify({ version, checkedAt: now } satisfies ReleaseMetadata),
      );
    } catch {
      return { status: "failed", reason: "storage_unavailable" };
    }
    return { status: "updated", version };
  } catch {
    return { status: "failed", reason: "upstream_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve dependencies once for direct tests and the deployed Worker entry points. */
function resolveDeps(deps: ReleaseProxyDeps): Required<ReleaseProxyDeps> {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    log: deps.log ?? console.log,
    now: deps.now ?? Date.now,
    upstreamTimeoutMs: deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
  };
}

/** Serve fresh global metadata without coupling request traffic to GitHub. */
export function createReleaseProxyHandler(deps: ReleaseProxyDeps = {}) {
  const resolved = resolveDeps(deps);

  return async (request: Request, env: ReleaseProxyEnv, _ctx: WorkerExecutionContext) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== RELEASE_ROUTE) {
      return jsonResponse({ error: "not_found" }, 404);
    }

    resolved.log(
      JSON.stringify({
        event: "release_check",
        source: requestSource(request),
        currentVersion: currentVersion(request),
      }),
    );

    let stored: ReleaseMetadata | undefined;
    try {
      stored = releaseMetadata(await env.RELEASE_METADATA.get(RELEASE_METADATA_KEY));
    } catch {
      return jsonResponse({ error: "storage_unavailable" }, 502);
    }

    if (!stored || !isFreshMetadata(stored, resolved.now())) {
      return jsonResponse({ error: "metadata_unavailable" }, 503);
    }

    return jsonResponse({ version: stored.version });
  };
}

/** Refresh global release metadata on the Worker's cron without discarding stale valid data. */
export function createReleaseProxyScheduledHandler(deps: ReleaseProxyDeps = {}) {
  const resolved = resolveDeps(deps);

  return async (
    _controller: ScheduledController,
    env: ReleaseProxyEnv,
    _ctx: WorkerExecutionContext,
  ) => {
    const result = await refreshReleaseVersion(env, resolved);
    resolved.log(
      JSON.stringify({
        event: "release_refresh",
        status: result.status,
        ...(result.status === "failed"
          ? {
              reason: result.reason,
              ...(result.upstreamStatus ? { upstreamStatus: result.upstreamStatus } : {}),
            }
          : { version: result.version }),
      }),
    );
  };
}

export default {
  fetch: createReleaseProxyHandler(),
  scheduled: createReleaseProxyScheduledHandler(),
};
