import { describe, expect, test } from "bun:test";
import { createReleaseProxyHandler } from "./index";

/** Build a direct invocation context and retain deferred cache work for assertions. */
function createTestContext() {
  const pending: Promise<unknown>[] = [];
  return {
    context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    settle: () => Promise.all(pending),
  };
}

/** Build a tiny in-memory implementation of the Worker cache seam. */
function createTestCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, response.clone());
      },
    },
  };
}

describe("release proxy Worker", () => {
  test("normalizes and caches GitHub's latest stable release", async () => {
    const upstreamRequests: Array<{ url: string; headers: Headers }> = [];
    const { cache, entries } = createTestCache();
    const { context, settle } = createTestContext();
    const handler = createReleaseProxyHandler({
      cache,
      fetchImpl: async (input, init) => {
        upstreamRequests.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json({ tag_name: "v1.2.3" });
      },
      log: () => {},
    });

    const response = await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest"),
      {},
      context,
    );
    await settle();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "1.2.3" });
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]?.url).toBe(
      "https://api.github.com/repos/modem-dev/hunk/releases/latest",
    );
    expect(upstreamRequests[0]?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(upstreamRequests[0]?.headers.get("user-agent")).toBe("hunk-release-proxy");
    expect(entries.has("https://updates.hunk.dev/v1/curl/latest")).toBe(true);

    const second = await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest"),
      {},
      context,
    );
    expect(await second.json()).toEqual({ version: "1.2.3" });
    expect(upstreamRequests).toHaveLength(1);
  });

  test("rejects prereleases and malformed GitHub payloads", async () => {
    for (const payload of [{ tag_name: "v1.2.3-beta.1" }, { name: "v1.2.3" }, null]) {
      const { context } = createTestContext();
      const handler = createReleaseProxyHandler({
        fetchImpl: async () => Response.json(payload),
        log: () => {},
      });
      const response = await handler(
        new Request("https://updates.hunk.dev/v1/curl/latest"),
        {},
        context,
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "invalid_upstream_response" });
    }
  });

  test("contains upstream failures and unknown routes", async () => {
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      fetchImpl: async () => {
        throw new Error("offline");
      },
      log: () => {},
    });

    const failed = await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest"),
      {},
      context,
    );
    expect(failed.status).toBe(502);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await failed.json()).toEqual({ error: "upstream_unavailable" });

    const missing = await handler(new Request("https://updates.hunk.dev/other"), {}, context);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("bounds a stalled GitHub lookup", async () => {
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      upstreamTimeoutMs: 1,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      log: () => {},
    });

    const response = await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest"),
      {},
      context,
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("bounds a stalled GitHub response body", async () => {
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      upstreamTimeoutMs: 1,
      fetchImpl: async (_input, init) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body);
      },
      log: () => {},
    });

    const response = await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest"),
      {},
      context,
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("logs only allowlisted request dimensions", async () => {
    const logs: string[] = [];
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      fetchImpl: async () => Response.json({ tag_name: "v1.2.3" }),
      log: (entry) => logs.push(entry),
    });

    await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest?ignored=secret", {
        headers: {
          cookie: "session=secret",
          "x-hunk-current-version": "1.0.0-beta.1",
          "x-hunk-request-source": "startup",
          "x-other": "secret",
        },
      }),
      {},
      context,
    );
    for (const currentVersion of [
      "not a version with private text",
      "1.2.3-private-repository-name",
    ]) {
      await handler(
        new Request("https://updates.hunk.dev/v1/curl/latest", {
          headers: {
            "x-hunk-current-version": currentVersion,
            "x-hunk-request-source": "private-source",
          },
        }),
        {},
        context,
      );
    }

    expect(logs.map((entry) => JSON.parse(entry))).toEqual([
      { event: "release_check", source: "startup", currentVersion: "1.0.0-beta.1" },
      { event: "release_check", source: "unknown", currentVersion: "unknown" },
      { event: "release_check", source: "unknown", currentVersion: "unknown" },
    ]);
    expect(logs.join(" ")).not.toContain("secret");
  });
});
