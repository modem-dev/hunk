import { describe, expect, test } from "bun:test";
import { handleExtensionActivityRequest } from "./extension-activity";

/** Build a fetch-compatible stub around one concise test callback. */
function createTestFetch(
  callback: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
) {
  return callback as typeof fetch;
}

describe("extension activity endpoint", () => {
  test("returns compact GitHub activity with shared CDN caching", async () => {
    let requestedUrl = "";
    const fetchUpstream = createTestFetch((input) => {
      requestedUrl = String(input);
      return Response.json({
        items: [
          {
            full_name: "Elucid/Hunk-Less-Search",
            stargazers_count: 12,
            pushed_at: "2026-08-20T03:25:47Z",
            created_at: "2026-08-16T22:57:51Z",
            description: "This upstream field must not be forwarded",
          },
        ],
      });
    });

    const response = await handleExtensionActivityRequest(
      new Request("https://hunk.dev/api/extension-activity"),
      fetchUpstream,
    );

    expect(requestedUrl).toContain("api.github.com/search/repositories");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400",
    );
    expect(await response.json()).toMatchObject({
      fetchedAt: expect.any(String),
      repositories: [
        {
          repo: "elucid/hunk-less-search",
          stars: 12,
          pushedAt: "2026-08-20T03:25:47Z",
          createdAt: "2026-08-16T22:57:51Z",
        },
      ],
    });
  });

  test("does not cache upstream failures", async () => {
    const response = await handleExtensionActivityRequest(
      new Request("https://hunk.dev/api/extension-activity"),
      createTestFetch(() => new Response("rate limited", { status: 429 })),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Extension activity is temporarily unavailable",
    });
  });

  test("rejects non-GET requests without calling GitHub", async () => {
    let called = false;
    const response = await handleExtensionActivityRequest(
      new Request("https://hunk.dev/api/extension-activity", { method: "POST" }),
      createTestFetch(() => {
        called = true;
        return new Response();
      }),
    );

    expect(called).toBe(false);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
