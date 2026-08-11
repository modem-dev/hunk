import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReviewCanonicalFileResourceDescriptorV1 } from "../../core/review/types";
import { BrowserReviewApiClient, BrowserReviewConflictError } from "./apiClient";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  readonly url: string;
  readonly withCredentials = true;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    TestEventSource.instances.push(this);
  }

  close() {
    this.readyState = 2;
  }
}

function descriptor(
  generation: string,
  id = "canonical:1",
  content = "{}",
): ReviewCanonicalFileResourceDescriptorV1 {
  return {
    id,
    kind: "canonical-file",
    generation,
    fileKey: id,
    contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
    byteLength: content.length,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

describe("browser canonical resource queue", () => {
  test("rebuilds failed event streams without allowing stale probes to overwrite recovery", async () => {
    TestEventSource.instances = [];
    globalThis.EventSource = TestEventSource as unknown as typeof EventSource;
    let resolveProbe!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    const client = new BrowserReviewApiClient("session", (() => probe) as unknown as typeof fetch);
    const errors: Array<number | undefined> = [];
    let opens = 0;
    const stop = client.events({
      onEvent: () => undefined,
      onMalformed: () => undefined,
      onOpen: () => {
        opens += 1;
      },
      onError: (status) => errors.push(status),
    });
    const first = TestEventSource.instances[0]!;
    first.onerror?.(new Event("error"));
    await Bun.sleep(300);
    const replacement = TestEventSource.instances[1]!;
    replacement.onopen?.(new Event("open"));
    resolveProbe(new Response(null, { status: 401 }));
    await Bun.sleep(0);
    expect(errors).toEqual([undefined]);
    expect(opens).toBe(1);
    expect(TestEventSource.instances).toHaveLength(2);
    stop();
  });

  test("drops queued messages when their event stream is retired", async () => {
    TestEventSource.instances = [];
    globalThis.EventSource = TestEventSource as unknown as typeof EventSource;
    const client = new BrowserReviewApiClient("session");
    let delivered = 0;
    const stop = client.events({
      onEvent: () => {
        delivered += 1;
      },
      onMalformed: () => undefined,
      onOpen: () => undefined,
      onError: () => undefined,
    });
    TestEventSource.instances[0]!.dispatchEvent(
      new MessageEvent("state", {
        data: JSON.stringify({ generation: "generation:old", state: {} }),
      }),
    );
    stop();
    await Bun.sleep(0);
    expect(delivered).toBe(0);
  });

  test("recreates an event stream after a transient status probe", async () => {
    TestEventSource.instances = [];
    globalThis.EventSource = TestEventSource as unknown as typeof EventSource;
    const client = new BrowserReviewApiClient(
      "session",
      (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    );
    const stop = client.events({
      onEvent: () => undefined,
      onMalformed: () => undefined,
      onOpen: () => undefined,
      onError: () => undefined,
    });
    TestEventSource.instances[0]!.onerror?.(new Event("error"));
    await Bun.sleep(300);
    expect(TestEventSource.instances).toHaveLength(2);
    stop();
  });

  test("selection and note revisions reuse one generation resource fetch", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("{}", { status: 200, headers: { "content-length": "2" } });
    }) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:1");
    const resource = descriptor("generation:1");
    expect(await client.resource("generation:1", resource)).toBe("{}");
    expect(await client.resource("generation:1", resource)).toBe("{}");
    expect(requests).toBe(1);
  });

  test("derives lazy canonical totals from verified daemon range responses", async () => {
    const content = '{"canonical":true}';
    globalThis.fetch = (async () =>
      new Response(content, {
        status: 206,
        headers: { "content-range": `bytes 0-${content.length - 1}/${content.length}` },
      })) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:lazy");
    const lazy = descriptor("generation:lazy");
    delete lazy.byteLength;
    delete lazy.digest;
    expect(await client.resource("generation:lazy", lazy)).toBe(content);
  });

  test("generation replacement aborts obsolete inflight and queued work", async () => {
    let aborted = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:old");
    const pending = client.resource("generation:old", descriptor("generation:old"));
    client.replaceGeneration("generation:new");
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(aborted).toBe(1);
  });

  test("retries a released resource without an obsolete rejection deleting the retry cache", async () => {
    let requests = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (requests > 1) return Promise.resolve(new Response("{}", { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    const generation = "generation:retry";
    const resource = descriptor(generation);
    client.replaceGeneration(generation);
    const controller = new AbortController();
    const obsolete = client.resource(generation, resource, controller.signal);
    controller.abort();
    client.releaseResource(generation, resource.id);
    await expect(obsolete).rejects.toHaveProperty("name", "AbortError");
    expect(await client.resource(generation, resource)).toBe("{}");
    expect(await client.resource(generation, resource)).toBe("{}");
    expect(requests).toBe(2);
  });

  test("sends generation and revision preconditions with every semantic action", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        kind: "review-action",
        generation: "generation:action",
        stateRevision: 4,
        state: {
          documentGeneration: "generation:action",
          stateRevision: 4,
          selection: { fileKey: "file", hunkIndex: 0 },
          filter: "src",
          showAgentNotes: false,
          notes: [],
        },
      });
    }) as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    await client.action("generation:action", 3, { type: "filter/set", filter: "src" });
    expect(body).toEqual({
      generation: "generation:action",
      expectedStateRevision: 3,
      action: { type: "filter/set", filter: "src" },
    });
  });

  test("parses typed generation and revision conflicts", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          kind: "review-error",
          error: {
            code: "stale-revision",
            message: "Review state changed.",
            currentGeneration: "generation:new",
          },
        },
        { status: 409 },
      )) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    const pending = client.action("generation:old", 1, {
      type: "notes/set-visibility",
      visible: true,
    });
    await expect(pending).rejects.toBeInstanceOf(BrowserReviewConflictError);
    await expect(pending).rejects.toMatchObject({
      status: 409,
      code: "stale-revision",
      currentGeneration: "generation:new",
    });
  });

  test("keeps lazy resource concurrency within daemon reservation capacity", async () => {
    let active = 0;
    let maximum = 0;
    globalThis.fetch = (async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Bun.sleep(10);
      active -= 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:large");
    const pending = Array.from({ length: 20 }, (_, index) =>
      client.resource("generation:large", descriptor("generation:large", `canonical:${index}`)),
    );
    await Promise.all(pending);
    expect(maximum).toBe(4);
  });
});
