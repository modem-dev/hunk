import { describe, expect, test } from "bun:test";
import { createReleaseProxyHandler, createReleaseProxyScheduledHandler } from "./index";

const NOW = 2_000_000_000_000;
const RELEASE_METADATA_KEY = "latest-stable-release";

/** Build a direct invocation context and retain deferred work for assertions. */
function createTestContext() {
  const pending: Promise<unknown>[] = [];
  return {
    context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    settle: () => Promise.all(pending),
  };
}

/** Encode one value as the Worker's validated global metadata record. */
function metadata(version: string, checkedAt = NOW) {
  return JSON.stringify({ version, checkedAt });
}

/** Build a tiny in-memory implementation of the Worker KV binding. */
function createTestReleaseMetadata(initialValue?: string) {
  const entries = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  if (initialValue) entries.set(RELEASE_METADATA_KEY, initialValue);
  return {
    entries,
    writes,
    namespace: {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        writes.push({ key, value });
        entries.set(key, value);
      },
    },
  };
}

/** Build the production route request used throughout the Worker tests. */
function releaseRequest(init?: RequestInit) {
  return new Request("https://updates.hunk.dev/v1/curl/latest", init);
}

/** Build the shape Cloudflare supplies to a scheduled Worker invocation. */
function scheduledController() {
  return { scheduledTime: NOW, cron: "* * * * *" };
}

describe("release proxy Worker", () => {
  test("serves fresh global metadata without requesting GitHub", async () => {
    const { namespace } = createTestReleaseMetadata(metadata("1.2.3"));
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      fetchImpl: async () => {
        throw new Error("requests must not reach GitHub");
      },
      log: () => {},
      now: () => NOW,
    });

    const response = await handler(releaseRequest(), { RELEASE_METADATA: namespace }, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: "1.2.3" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("returns an error for empty, invalid, future, or stale metadata without requesting GitHub", async () => {
    const values = [
      undefined,
      "not json",
      metadata("1.2.3", NOW + 1),
      metadata("1.2.3", NOW - 6 * 60 * 60 * 1_000 - 1),
    ];
    for (const value of values) {
      const { namespace } = createTestReleaseMetadata(value);
      const { context } = createTestContext();
      let upstreamRequests = 0;
      const handler = createReleaseProxyHandler({
        fetchImpl: async () => {
          upstreamRequests += 1;
          return Response.json({ tag_name: "v1.2.4" });
        },
        log: () => {},
        now: () => NOW,
      });

      const response = await handler(releaseRequest(), { RELEASE_METADATA: namespace }, context);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "metadata_unavailable" });
      expect(upstreamRequests).toBe(0);
    }
  });

  test("contains KV read failures", async () => {
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({ log: () => {}, now: () => NOW });
    const response = await handler(
      releaseRequest(),
      {
        RELEASE_METADATA: {
          get: async () => {
            throw new Error("KV unavailable");
          },
          put: async () => {},
        },
      },
      context,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "storage_unavailable" });
  });

  test("refreshes global metadata from GitHub with the Worker secret", async () => {
    const upstreamRequests: Array<{ url: string; headers: Headers }> = [];
    const logs: string[] = [];
    const { namespace, entries } = createTestReleaseMetadata(metadata("1.2.2", NOW - 3_600_000));
    const { context } = createTestContext();
    const scheduled = createReleaseProxyScheduledHandler({
      fetchImpl: async (input, init) => {
        upstreamRequests.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json({ tag_name: "v1.2.3" });
      },
      log: (entry) => logs.push(entry),
      now: () => NOW,
    });

    await scheduled(
      scheduledController(),
      { RELEASE_METADATA: namespace, GITHUB_TOKEN: "worker-secret" },
      context,
    );

    expect(JSON.parse(entries.get(RELEASE_METADATA_KEY) ?? "null")).toEqual({
      version: "1.2.3",
      checkedAt: NOW,
    });
    expect(upstreamRequests[0]?.url).toBe(
      "https://api.github.com/repos/modem-dev/hunk/releases/latest",
    );
    expect(upstreamRequests[0]?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe("Bearer worker-secret");
    expect(upstreamRequests[0]?.headers.get("user-agent")).toBe("hunk-release-proxy");
    expect(upstreamRequests[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(logs.map((entry) => JSON.parse(entry))).toEqual([
      { event: "release_refresh", status: "updated", version: "1.2.3" },
    ]);
  });

  test("does not rewrite unchanged metadata more than once per hour", async () => {
    const { namespace, writes } = createTestReleaseMetadata(metadata("1.2.3", NOW - 59 * 60_000));
    const { context } = createTestContext();
    const scheduled = createReleaseProxyScheduledHandler({
      fetchImpl: async () => Response.json({ tag_name: "v1.2.3" }),
      log: () => {},
      now: () => NOW,
    });

    await scheduled(scheduledController(), { RELEASE_METADATA: namespace }, context);

    expect(writes).toEqual([]);
  });

  test("refreshes the metadata heartbeat after one hour", async () => {
    const { namespace, entries, writes } = createTestReleaseMetadata(
      metadata("1.2.3", NOW - 60 * 60_000),
    );
    const { context } = createTestContext();
    const scheduled = createReleaseProxyScheduledHandler({
      fetchImpl: async () => Response.json({ tag_name: "v1.2.3" }),
      log: () => {},
      now: () => NOW,
    });

    await scheduled(scheduledController(), { RELEASE_METADATA: namespace }, context);

    expect(writes).toHaveLength(1);
    expect(JSON.parse(entries.get(RELEASE_METADATA_KEY) ?? "null")).toEqual({
      version: "1.2.3",
      checkedAt: NOW,
    });
  });

  test("preserves last-known metadata when a scheduled refresh fails", async () => {
    const logs: string[] = [];
    const initial = metadata("1.2.3", NOW - 3_600_000);
    const { namespace, entries } = createTestReleaseMetadata(initial);
    const { context } = createTestContext();
    const scheduled = createReleaseProxyScheduledHandler({
      fetchImpl: async () => new Response("rate limited", { status: 403 }),
      log: (entry) => logs.push(entry),
      now: () => NOW,
    });

    await scheduled(scheduledController(), { RELEASE_METADATA: namespace }, context);

    expect(entries.get(RELEASE_METADATA_KEY)).toBe(initial);
    expect(logs.map((entry) => JSON.parse(entry))).toEqual([
      {
        event: "release_refresh",
        status: "failed",
        reason: "upstream_unavailable",
        upstreamStatus: 403,
      },
    ]);
  });

  test("reports KV write failures separately and preserves last-known metadata", async () => {
    const initial = metadata("1.2.3", NOW - 3_600_000);
    const logs: string[] = [];
    const { context } = createTestContext();
    const scheduled = createReleaseProxyScheduledHandler({
      fetchImpl: async () => Response.json({ tag_name: "v1.2.4" }),
      log: (entry) => logs.push(entry),
      now: () => NOW,
    });

    await scheduled(
      scheduledController(),
      {
        RELEASE_METADATA: {
          get: async () => initial,
          put: async () => {
            throw new Error("KV unavailable");
          },
        },
      },
      context,
    );

    expect(logs.map((entry) => JSON.parse(entry))).toEqual([
      { event: "release_refresh", status: "failed", reason: "storage_unavailable" },
    ]);
  });

  test("rejects prereleases and malformed GitHub payloads", async () => {
    for (const payload of [{ tag_name: "v1.2.3-beta.1" }, { name: "v1.2.3" }, null]) {
      const logs: string[] = [];
      const { namespace, writes } = createTestReleaseMetadata();
      const { context } = createTestContext();
      const scheduled = createReleaseProxyScheduledHandler({
        fetchImpl: async () => Response.json(payload),
        log: (entry) => logs.push(entry),
        now: () => NOW,
      });

      await scheduled(scheduledController(), { RELEASE_METADATA: namespace }, context);
      expect(writes).toEqual([]);
      expect(logs.map((entry) => JSON.parse(entry))).toEqual([
        { event: "release_refresh", status: "failed", reason: "invalid_upstream_response" },
      ]);
    }
  });

  test("bounds stalled GitHub lookups and response bodies", async () => {
    const fetches = [
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body);
      },
    ];

    for (const fetchImpl of fetches) {
      const logs: string[] = [];
      const { namespace } = createTestReleaseMetadata();
      const { context } = createTestContext();
      const scheduled = createReleaseProxyScheduledHandler({
        upstreamTimeoutMs: 1,
        fetchImpl,
        log: (entry) => logs.push(entry),
        now: () => NOW,
      });

      await scheduled(scheduledController(), { RELEASE_METADATA: namespace }, context);
      expect(logs.map((entry) => JSON.parse(entry))).toEqual([
        { event: "release_refresh", status: "failed", reason: "upstream_unavailable" },
      ]);
    }
  });

  test("contains unknown routes and logs only allowlisted request dimensions", async () => {
    const logs: string[] = [];
    const { namespace } = createTestReleaseMetadata(metadata("1.2.3"));
    const { context } = createTestContext();
    const handler = createReleaseProxyHandler({
      log: (entry) => logs.push(entry),
      now: () => NOW,
    });

    const missing = await handler(
      new Request("https://updates.hunk.dev/other"),
      { RELEASE_METADATA: namespace },
      context,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    await handler(
      new Request("https://updates.hunk.dev/v1/curl/latest?ignored=secret", {
        headers: {
          cookie: "session=secret",
          "x-hunk-current-version": "1.0.0-beta.1",
          "x-hunk-request-source": "startup",
          "x-other": "secret",
        },
      }),
      { RELEASE_METADATA: namespace },
      context,
    );
    for (const version of ["not a version with private text", "1.2.3-private-repository-name"]) {
      await handler(
        releaseRequest({
          headers: {
            "x-hunk-current-version": version,
            "x-hunk-request-source": "private-source",
          },
        }),
        { RELEASE_METADATA: namespace },
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
