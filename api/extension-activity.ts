import {
  createExtensionActivityPayload,
  githubTopicActivityUrl,
  indexActivityByRepo,
} from "../website/src/data/extensionActivity";

const CACHE_CONTROL = "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400";
const NO_STORE = "no-store";

/** Build the authenticated GitHub headers available only to the server. */
function githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "hunk.dev-extension-directory",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Return one JSON response with an explicit browser and CDN cache policy. */
function jsonResponse(payload: unknown, status: number, cacheControl: string) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": cacheControl },
  });
}

/** Serve compact extension activity through Vercel's shared CDN cache. */
export async function handleExtensionActivityRequest(
  request: Request,
  fetchUpstream: typeof fetch = fetch,
) {
  if (request.method !== "GET") {
    const response = jsonResponse({ error: "Method not allowed" }, 405, NO_STORE);
    response.headers.set("Allow", "GET");
    return response;
  }

  try {
    const upstream = await fetchUpstream(githubTopicActivityUrl(), {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      return jsonResponse(
        { error: "Extension activity is temporarily unavailable" },
        502,
        NO_STORE,
      );
    }

    const activity = indexActivityByRepo(await upstream.json());
    if (!activity.size) {
      return jsonResponse(
        { error: "Extension activity is temporarily unavailable" },
        502,
        NO_STORE,
      );
    }

    return jsonResponse(createExtensionActivityPayload(activity), 200, CACHE_CONTROL);
  } catch {
    return jsonResponse({ error: "Extension activity is temporarily unavailable" }, 502, NO_STORE);
  }
}

export default {
  /** Adapt the web-standard handler to Vercel's fetch function contract. */
  fetch(request: Request) {
    return handleExtensionActivityRequest(request);
  },
};
