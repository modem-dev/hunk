import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../../test/helpers/session-daemon-fixtures";
import { MAX_BROWSER_REVIEW_SNAPSHOT_BYTES } from "../reviewProtocol";
import { BrowserReviewServer } from "./browserReviewServer";
import { ReviewResourceCache } from "./reviewResourceCache";
import { HunkSessionBrokerState } from "./state";

const ORIGIN = "http://127.0.0.1:47657";

class RacingReviewResourceCache extends ReviewResourceCache {
  onCacheHit: (() => void) | null = null;

  override get(sessionId: string, generation: string, resourceId: string) {
    const bytes = super.get(sessionId, generation, resourceId);
    if (bytes) this.onCacheHit?.();
    return bytes;
  }
}

function capabilityHash(capability: string) {
  return createHash("sha256").update(capability).digest("hex");
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { host: "127.0.0.1:47657", ...init.headers },
  });
}

async function authorize(server: BrowserReviewServer, sessionId: string, capability: string) {
  const response = await server.handle(
    request("/review-auth", {
      method: "POST",
      headers: {
        host: "127.0.0.1:47657",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, capability }),
    }),
  );
  expect(response?.status).toBe(200);
  const setCookie = response!.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain(`Path=/review-api/${encodeURIComponent(sessionId)}/`);
  return setCookie.split(";", 1)[0]!;
}

/** Build a broker-state façade carrying near-maximum independent manifest and state payloads. */
function createCombinedSnapshotState() {
  const capability = "combined-capability";
  const snapshot = {
    generation: "generation:combined",
    manifest: { padding: "m".repeat(4 * 1024 * 1024 - 64 * 1024) },
    state: { stateRevision: 0, padding: "s".repeat(6 * 1024 * 1024 - 64 * 1024) },
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  expect(serializedBytes).toBeLessThanOrEqual(MAX_BROWSER_REVIEW_SNAPSHOT_BYTES);
  expect(serializedBytes).toBeGreaterThan(9 * 1024 * 1024);
  const state = {
    subscribeReviewEvents: () => () => undefined,
    getBrowserReviewCapabilityHash: (sessionId: string) =>
      sessionId === "combined-session" ? capabilityHash(capability) : undefined,
    getBrowserReviewSnapshot: (sessionId: string) => {
      if (sessionId !== "combined-session") throw new Error("Session missing.");
      return snapshot;
    },
  } as unknown as HunkSessionBrokerState;
  return { state, snapshot, capability };
}

function createRegisteredState(
  sessionId = "session-1",
  capability = "capability-one",
  snapshot = createTestSessionSnapshot(),
  state = new HunkSessionBrokerState(),
) {
  const socket = {
    send(text: string) {
      const message = JSON.parse(text) as any;
      if (message.command === "read_review_resource") {
        const patch = "@@ -1,1 +1,1 @@";
        const bytes = Buffer.from(patch);
        const offset = message.input.offset;
        const chunk = bytes.subarray(offset, offset + message.input.length);
        queueMicrotask(() =>
          state.handleCommandResult(socket, {
            requestId: message.requestId,
            ok: true,
            result: {
              kind: "review-resource",
              generation: "generation:test",
              id: "resource:test:0",
              resourceId: "resource:test:0",
              offset,
              byteLength: chunk.byteLength,
              encoding: "base64",
              data: chunk.toString("base64"),
              contentDigest: createHash("sha256").update(patch).digest("hex"),
              contentSize: bytes.byteLength,
              eof: offset + chunk.byteLength === bytes.byteLength,
            },
          }),
        );
      } else if (message.command === "apply_review_action") {
        const valid = message.input.action?.type === "notes/set-visibility";
        queueMicrotask(() =>
          state.handleCommandResult(socket, {
            requestId: message.requestId,
            ok: true,
            result: valid
              ? {
                  kind: "review-action",
                  generation: "generation:test",
                  stateRevision: 1,
                  state: {
                    ...createTestSessionSnapshot().state.review,
                    stateRevision: 1,
                    showAgentNotes: true,
                  },
                }
              : {
                  kind: "review-error",
                  error: { code: "unsupported-action", message: "Unsupported action." },
                },
          }),
        );
      }
    },
  };
  const registration = createTestSessionRegistration({ sessionId });
  registration.info.browserReviewCapabilityHash = capabilityHash(capability);
  expect(state.registerSession(socket, registration, snapshot)).toBe(true);
  return { state, socket, registration };
}

interface FakeTimer {
  at: number;
  callback: () => void;
}

/** Provide deterministic timeout scheduling while allowing event-time expiry tests. */
function createFakeClock(initialNow = 1_000) {
  let now = initialNow;
  let sequence = 0;
  const timers = new Map<number, FakeTimer>();
  const setTimeoutImpl = ((callback: () => void, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { at: now + Number(delay), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutImpl = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;
  return {
    now: () => now,
    setTimeoutImpl,
    clearTimeoutImpl,
    jumpWithoutTimers(milliseconds: number) {
      now += milliseconds;
    },
    advance(milliseconds: number) {
      now += milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

/** Read one server-emitted SSE frame. */
async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  if (result.value) expect(result.value.byteLength).toBeLessThanOrEqual(64 * 1024);
  return { ...result, text: result.value ? new TextDecoder().decode(result.value) : "" };
}

/** Reconstruct one chunked snapshot batch and validate its deterministic metadata. */
async function readChunkedSnapshot(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstText?: string,
) {
  const beginText = firstText ?? (await readSseFrame(reader)).text;
  expect(beginText).toContain("event: snapshot-begin");
  const begin = JSON.parse(beginText.match(/^data: (.+)$/m)![1]!) as {
    id: string;
    byteLength: number;
    chunkCount: number;
    digest: string;
  };
  expect(begin.id.length).toBeLessThanOrEqual(128);
  expect(begin.id).not.toContain("generation:");
  const chunks: Buffer[] = [];
  for (let index = 0; index < begin.chunkCount; index += 1) {
    const chunkText = (await readSseFrame(reader)).text;
    expect(chunkText).toContain("event: snapshot-chunk");
    const chunk = JSON.parse(chunkText.match(/^data: (.+)$/m)![1]!) as {
      id: string;
      index: number;
      data: string;
    };
    expect(chunk.id).toBe(begin.id);
    expect(chunk.id.length).toBeLessThanOrEqual(128);
    expect(chunk.index).toBe(index);
    chunks.push(Buffer.from(chunk.data, "base64"));
  }
  const endText = (await readSseFrame(reader)).text;
  expect(endText).toContain("event: snapshot-end");
  const end = JSON.parse(endText.match(/^data: (.+)$/m)![1]!) as typeof begin;
  const bytes = Buffer.concat(chunks);
  expect(bytes.byteLength).toBe(begin.byteLength);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(begin.digest);
  expect(end).toMatchObject({
    id: begin.id,
    byteLength: begin.byteLength,
    chunkCount: begin.chunkCount,
    digest: begin.digest,
  });
  return JSON.parse(bytes.toString("utf8")) as any;
}

const servers: BrowserReviewServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("browser review server", () => {
  test("serves only embedded no-store assets with strict browser security headers", async () => {
    const { state } = createRegisteredState();
    const server = new BrowserReviewServer(state);
    servers.push(server);
    const html = await server.handle(request("/review/session-1/"));
    expect(html?.status).toBe(200);
    expect(html?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html?.headers.get("cache-control")).toContain("no-store");
    const csp = html?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(html?.headers.get("referrer-policy")).toBe("no-referrer");
    const htmlText = await html?.text();
    expect(htmlText).toContain("./bootstrap.js");
    expect(htmlText).not.toContain("__HUNK_REVIEW_NONCE__");
    const script = await server.handle(request("/review/session-1/bootstrap.js"));
    expect(script?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script?.text()).toContain("history.replaceState");
    expect(await server.handle(request("/review/session-1/not-found.js"))).toBeUndefined();
  });

  test("exchanges a capability for an expiring session-scoped cookie without cross-session access", async () => {
    let now = 1_000;
    const first = createRegisteredState("session-1", "first-secret");
    const secondRegistration = createTestSessionRegistration({ sessionId: "session-2" });
    secondRegistration.info.browserReviewCapabilityHash = capabilityHash("second-secret");
    const secondSocket = { send() {} };
    expect(
      first.state.registerSession(secondSocket, secondRegistration, createTestSessionSnapshot()),
    ).toBe(true);
    const server = new BrowserReviewServer(first.state, { cookieTtlMs: 1_000, now: () => now });
    servers.push(server);
    expect(JSON.stringify(first.state.listSessions())).not.toContain("first-secret");
    expect(JSON.stringify(first.state.listSessions())).not.toContain(
      capabilityHash("first-secret"),
    );

    const wrong = await server.handle(
      request("/review-auth", {
        method: "POST",
        headers: { host: "127.0.0.1:47657", origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1", capability: "wrong" }),
      }),
    );
    expect(wrong?.status).toBe(401);
    const cookie = await authorize(server, "session-1", "first-secret");
    const own = await server.handle(
      request("/review-api/session-1/snapshot", { headers: { cookie } }),
    );
    expect(own?.status).toBe(200);
    const other = await server.handle(
      request("/review-api/session-2/snapshot", { headers: { cookie } }),
    );
    expect(other?.status).toBe(401);

    first.state.unregisterSocket(first.socket);
    const replacement = createTestSessionRegistration({ sessionId: "session-1" });
    replacement.info.browserReviewCapabilityHash = capabilityHash("replacement-secret");
    expect(
      first.state.registerSession({ send() {} }, replacement, createTestSessionSnapshot()),
    ).toBe(true);
    const stale = await server.handle(
      request("/review-api/session-1/snapshot", { headers: { cookie } }),
    );
    expect(stale?.status).toBe(401);
    const replacementCookie = await authorize(server, "session-1", "replacement-secret");
    now += 1_001;
    const expired = await server.handle(
      request("/review-api/session-1/snapshot", { headers: { cookie: replacementCookie } }),
    );
    expect(expired?.status).toBe(401);
  });

  test("requires exact same-origin JSON posts and bounds request bodies", async () => {
    const { state } = createRegisteredState();
    const server = new BrowserReviewServer(state);
    servers.push(server);
    const foreign = await server.handle(
      request("/review-auth", {
        method: "POST",
        headers: {
          host: "127.0.0.1:47657",
          origin: "http://localhost:47657",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: "session-1", capability: "capability-one" }),
      }),
    );
    expect(foreign?.status).toBe(403);
    const large = await server.handle(
      request("/review-auth", {
        method: "POST",
        headers: { host: "127.0.0.1:47657", origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "session-1", capability: "x".repeat(9_000) }),
      }),
    );
    expect(large?.status).toBe(413);
  });

  test("rejects 300 KiB generations at browser path, action, and replay boundaries", async () => {
    const { state } = createRegisteredState();
    const server = new BrowserReviewServer(state, { heartbeatMs: 60_000 });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const oversized = "g".repeat(300 * 1024);

    const resource = await server.handle(
      request(`/review-api/session-1/resources/${oversized}/resource%3Atest%3A0`, {
        headers: { cookie },
      }),
    );
    expect(resource?.status).toBe(400);

    const action = await server.handle(
      request("/review-api/session-1/actions", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          generation: oversized,
          action: { type: "notes/set-visibility", visible: true },
        }),
      }),
    );
    expect(action?.status).toBe(413);

    const events = await server.handle(
      request("/review-api/session-1/events", {
        headers: { cookie, "last-event-id": oversized },
      }),
    );
    expect(events?.status).toBe(400);
    expect(server.getSubscriberCount()).toBe(0);
  });

  test("serves verified bounded ranges and returns typed stale-generation conflicts", async () => {
    const { state } = createRegisteredState();
    const server = new BrowserReviewServer(state);
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const ranged = await server.handle(
      request("/review-api/session-1/resources/generation%3Atest/resource%3Atest%3A0", {
        headers: { cookie, range: "bytes=3-7" },
      }),
    );
    expect(ranged?.status).toBe(206);
    expect(ranged?.headers.get("content-range")).toBe("bytes 3-7/15");
    expect(await ranged?.text()).toBe("-1,1 ");
    const stale = await server.handle(
      request("/review-api/session-1/resources/generation%3Aold/resource%3Atest%3A0", {
        headers: { cookie },
      }),
    );
    expect(stale?.status).toBe(409);
    await expect(stale?.json()).resolves.toMatchObject({
      code: "stale-generation",
      currentGeneration: "generation:test",
    });
  });

  test("maps cache-hit generation retirement races to a typed browser 409", async () => {
    const cache = new RacingReviewResourceCache();
    const state = new HunkSessionBrokerState(cache);
    const connected = createRegisteredState(
      "session-1",
      "capability-one",
      createTestSessionSnapshot(),
      state,
    );
    const server = new BrowserReviewServer(state);
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const path = "/review-api/session-1/resources/generation%3Atest/resource%3Atest%3A0";
    expect((await server.handle(request(path, { headers: { cookie } })))?.status).toBe(200);

    const replacement = structuredClone(connected.registration);
    replacement.info.documentGeneration = "generation:replacement";
    replacement.info.reviewManifest.generation = "generation:replacement";
    for (const resource of replacement.info.reviewManifest.resources) {
      resource.generation = "generation:replacement";
    }
    const replacementSnapshot = createTestSessionSnapshot({
      documentGeneration: "generation:replacement",
      review: {
        ...createTestSessionSnapshot().state.review,
        documentGeneration: "generation:replacement",
      },
    });
    cache.onCacheHit = () => {
      cache.onCacheHit = null;
      expect(state.registerSession(connected.socket, replacement, replacementSnapshot)).toBe(true);
    };
    const raced = await server.handle(request(path, { headers: { cookie } }));
    expect(raced?.status).toBe(409);
    await expect(raced?.json()).resolves.toMatchObject({
      code: "stale-generation",
      currentGeneration: "generation:replacement",
    });
  });

  test("proxies strict actions and maps producer stale or unsupported errors", async () => {
    const { state } = createRegisteredState();
    const server = new BrowserReviewServer(state);
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const action = await server.handle(
      request("/review-api/session-1/actions", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          generation: "generation:test",
          action: { type: "notes/set-visibility", visible: true },
        }),
      }),
    );
    expect(action?.status).toBe(200);
    await expect(action?.json()).resolves.toMatchObject({
      kind: "review-action",
      stateRevision: 1,
    });
    const stale = await server.handle(
      request("/review-api/session-1/actions", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          generation: "generation:old",
          action: { type: "notes/set-visibility", visible: true },
        }),
      }),
    );
    expect(stale?.status).toBe(409);
  });

  test("rejects a resource when its capability rotates during an asynchronous read", async () => {
    const connected = createRegisteredState();
    const originalRead = connected.state.getBrowserReviewResource.bind(connected.state);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    connected.state.getBrowserReviewResource = async (...args) => {
      const result = await originalRead(...args);
      await readGate;
      return result;
    };
    const server = new BrowserReviewServer(connected.state);
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const pending = server.handle(
      request("/review-api/session-1/resources/generation%3Atest/resource%3Atest%3A0", {
        headers: { cookie },
      }),
    );
    await Bun.sleep(0);
    const replacement = structuredClone(connected.registration);
    replacement.info.browserReviewCapabilityHash = capabilityHash("rotated-capability");
    expect(
      connected.state.registerSession(connected.socket, replacement, createTestSessionSnapshot()),
    ).toBe(true);
    releaseRead();
    expect((await pending)?.status).toBe(401);
  });

  test("rejects an action when its capability rotates while reading the body", async () => {
    const connected = createRegisteredState();
    const server = new BrowserReviewServer(connected.state);
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const body = JSON.stringify({
      generation: "generation:test",
      action: { type: "notes/set-visibility", visible: true },
    });
    let releaseBody!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        };
      },
    });
    const pending = server.handle(
      new Request("http://127.0.0.1:47657/review-api/session-1/actions", {
        method: "POST",
        headers: {
          cookie,
          host: "127.0.0.1:47657",
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    await Bun.sleep(0);
    const replacement = structuredClone(connected.registration);
    replacement.info.browserReviewCapabilityHash = capabilityHash("rotated-capability");
    expect(
      connected.state.registerSession(connected.socket, replacement, createTestSessionSnapshot()),
    ).toBe(true);
    releaseBody();
    expect((await pending)?.status).toBe(401);
  });

  test("expires idle SSE streams on their auth timer and rejects events after fake-clock expiry", async () => {
    const clock = createFakeClock();
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, {
      cookieTtlMs: 100,
      heartbeatMs: 60_000,
      now: clock.now,
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
    });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const idle = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie } }),
    );
    const idleReader = idle!.body!.getReader();
    expect(server.getSubscriberCount()).toBe(1);
    clock.advance(101);
    expect(server.getSubscriberCount()).toBe(0);
    await readSseFrame(idleReader);
    expect((await readSseFrame(idleReader)).done).toBe(true);

    const replacementCookie = await authorize(server, "session-1", "capability-one");
    const eventStream = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie: replacementCookie } }),
    );
    const eventReader = eventStream!.body!.getReader();
    clock.jumpWithoutTimers(101);
    const review = { ...createTestSessionSnapshot().state.review, stateRevision: 1 };
    state.updateSnapshot(
      socket,
      "session-1",
      createTestSessionSnapshot({ stateRevision: 1, review }),
    );
    expect(server.getSubscriberCount()).toBe(0);
    const initial = await readSseFrame(eventReader);
    expect(initial.text).toContain("event: snapshot");
    expect((await readSseFrame(eventReader)).done).toBe(true);
  });

  test("closes open SSE streams when the registered capability identity rotates", async () => {
    const connected = createRegisteredState();
    const server = new BrowserReviewServer(connected.state, { heartbeatMs: 60_000 });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const response = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie } }),
    );
    const reader = response!.body!.getReader();
    expect(server.getSubscriberCount()).toBe(1);
    const replacement = structuredClone(connected.registration);
    replacement.info.browserReviewCapabilityHash = capabilityHash("rotated-capability");
    expect(
      connected.state.registerSession(connected.socket, replacement, createTestSessionSnapshot()),
    ).toBe(true);
    expect(server.getSubscriberCount()).toBe(0);
    await readSseFrame(reader);
    expect((await readSseFrame(reader)).done).toBe(true);
  });

  test("chunks and reconstructs 600 KiB and near-limit initial snapshots without history duplication", async () => {
    for (const size of [600 * 1024, 5 * 1024 * 1024]) {
      const snapshot = createTestSessionSnapshot({
        review: { ...createTestSessionSnapshot().state.review, filter: "x".repeat(size) },
      });
      const { state } = createRegisteredState(`session-${size}`, `capability-${size}`, snapshot);
      const server = new BrowserReviewServer(state, { heartbeatMs: 60_000 });
      servers.push(server);
      const cookie = await authorize(server, `session-${size}`, `capability-${size}`);
      const response = await server.handle(
        request(`/review-api/session-${size}/events`, { headers: { cookie } }),
      );
      expect(response?.status).toBe(200);
      const reader = response!.body!.getReader();
      const reconstructed = await readChunkedSnapshot(reader);
      expect(reconstructed.state.filter).toHaveLength(size);
      expect(server.getHistoryEntryCount(`session-${size}`)).toBe(0);
      await reader.cancel();
      expect(server.getSubscriberBufferedByteCount()).toBe(0);

      const reconnect = await server.handle(
        request(`/review-api/session-${size}/events`, {
          headers: { cookie, "last-event-id": "not-retained" },
        }),
      );
      const reconnected = await readChunkedSnapshot(reconnect!.body!.getReader());
      expect(reconnected.state.filter).toHaveLength(size);
    }
  });

  test("serves and reconstructs the maximum combined manifest plus mutable-state budget", async () => {
    const combined = createCombinedSnapshotState();
    const server = new BrowserReviewServer(combined.state, {
      heartbeatMs: 60_000,
      sseChunkBytes: Number.MAX_SAFE_INTEGER,
    });
    servers.push(server);
    const cookie = await authorize(server, "combined-session", combined.capability);

    const get = await server.handle(
      request("/review-api/combined-session/snapshot", { headers: { cookie } }),
    );
    expect(get?.status).toBe(200);
    const getSnapshot = (await get?.json()) as typeof combined.snapshot;
    expect(getSnapshot.manifest.padding).toHaveLength(combined.snapshot.manifest.padding.length);
    expect(getSnapshot.state.padding).toHaveLength(combined.snapshot.state.padding.length);

    const events = await server.handle(
      request("/review-api/combined-session/events", { headers: { cookie } }),
    );
    expect(events?.status).toBe(200);
    const reconstructed = await readChunkedSnapshot(events!.body!.getReader());
    expect(reconstructed.manifest.padding).toHaveLength(combined.snapshot.manifest.padding.length);
    expect(reconstructed.state.padding).toHaveLength(combined.snapshot.state.padding.length);
  });

  test("admits four near-limit subscribers inside the conservative daemon aggregate budget", async () => {
    const combined = createCombinedSnapshotState();
    const server = new BrowserReviewServer(combined.state, { heartbeatMs: 60_000 });
    servers.push(server);
    const cookie = await authorize(server, "combined-session", combined.capability);
    const streams: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await server.handle(
        request("/review-api/combined-session/events", { headers: { cookie } }),
      );
      expect(response?.status).toBe(200);
      streams.push(response!);
      expect(server.getSubscriberCount()).toBe(index + 1);
    }
    const rejected = await server.handle(
      request("/review-api/combined-session/events", { headers: { cookie } }),
    );
    expect(rejected?.status).toBe(200);
    await expect(rejected!.text()).rejects.toThrow("too slow");
    expect(server.getSubscriberCount()).toBe(4);
    for (const stream of streams) await stream.body!.getReader().cancel();
    expect(server.getSubscriberCount()).toBe(0);
    expect(server.getSubscriberBufferedByteCount()).toBe(0);
  });

  test("replays retained chunked history, prunes whole entries, and falls back for unknown ids", async () => {
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, {
      heartbeatMs: 60_000,
      maxHistoryEntries: 2,
      maxHistoryBytes: 2 * 1024 * 1024,
      maxHistoryEntryBytes: 1024 * 1024,
    });
    servers.push(server);
    const largeFilter = "h".repeat(600 * 1024);
    for (let revision = 1; revision <= 3; revision += 1) {
      const review = {
        ...createTestSessionSnapshot().state.review,
        stateRevision: revision,
        filter: revision === 2 ? largeFilter : `revision-${revision}`,
      };
      expect(
        state.updateSnapshot(
          socket,
          "session-1",
          createTestSessionSnapshot({ stateRevision: revision, review }),
        ),
      ).toBe("updated");
    }
    expect(server.getHistoryEntryCount("session-1")).toBe(2);

    const cookie = await authorize(server, "session-1", "capability-one");
    const generation = createHash("sha256").update("generation:test").digest("hex").slice(0, 32);
    const replay = await server.handle(
      request("/review-api/session-1/events", {
        headers: { cookie, "last-event-id": `v1.${generation}.2.state.end` },
      }),
    );
    const replayFrame = await readSseFrame(replay!.body!.getReader());
    expect(replayFrame.text).toContain("event: state");
    expect(replayFrame.text).toContain('"stateRevision":3');

    const fallback = await server.handle(
      request("/review-api/session-1/events", {
        headers: { cookie, "last-event-id": "pruned-or-unknown" },
      }),
    );
    const fallbackFrame = await readSseFrame(fallback!.body!.getReader());
    expect(fallbackFrame.text).toContain("event: snapshot");
  });

  test("does not retain a semantic history entry that exceeds its complete-entry budget", () => {
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, {
      heartbeatMs: 60_000,
      maxHistoryEntryBytes: 64 * 1024,
    });
    servers.push(server);
    const review = {
      ...createTestSessionSnapshot().state.review,
      stateRevision: 1,
      filter: "z".repeat(600 * 1024),
    };
    expect(
      state.updateSnapshot(
        socket,
        "session-1",
        createTestSessionSnapshot({ stateRevision: 1, review }),
      ),
    ).toBe("updated");
    expect(server.getHistoryEntryCount("session-1")).toBe(0);
  });

  test("enforces aggregate subscriber bytes and cleans real cancellation and abort state", async () => {
    const snapshot = createTestSessionSnapshot({
      review: { ...createTestSessionSnapshot().state.review, filter: "q".repeat(100 * 1024) },
    });
    const first = createRegisteredState("session-1", "capability-one", snapshot);
    const secondRegistration = createTestSessionRegistration({ sessionId: "session-2" });
    secondRegistration.info.browserReviewCapabilityHash = capabilityHash("capability-two");
    expect(first.state.registerSession({ send() {} }, secondRegistration, snapshot)).toBe(true);
    const server = new BrowserReviewServer(first.state, {
      heartbeatMs: 60_000,
      maxTotalSubscriberBytes: 180 * 1024,
    });
    servers.push(server);
    const firstCookie = await authorize(server, "session-1", "capability-one");
    const secondCookie = await authorize(server, "session-2", "capability-two");
    const firstStream = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie: firstCookie } }),
    );
    await server.handle(
      request("/review-api/session-2/events", { headers: { cookie: secondCookie } }),
    );
    expect(server.getSubscriberCount()).toBe(1);
    expect(server.getSubscriberBufferedByteCount()).toBeLessThanOrEqual(180 * 1024);
    await firstStream!.body!.getReader().cancel();
    expect(server.getSubscriberCount()).toBe(0);
    expect(server.getSubscriberBufferedByteCount()).toBe(0);

    const abort = new AbortController();
    const abortedStream = await server.handle(
      request("/review-api/session-1/events", {
        headers: { cookie: firstCookie },
        signal: abort.signal,
      }),
    );
    expect(abortedStream?.status).toBe(200);
    expect(server.getSubscriberCount()).toBe(1);
    abort.abort();
    expect(server.getSubscriberCount()).toBe(0);
    expect(server.getSubscriberBufferedByteCount()).toBe(0);
  });

  test("closes slow subscribers when bounded event backpressure is exceeded", async () => {
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, {
      heartbeatMs: 60_000,
      maxSubscriberEvents: 1,
      maxSubscriberBytes: 32 * 1024,
    });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    await server.handle(request("/review-api/session-1/events", { headers: { cookie } }));
    expect(server.getSubscriberCount()).toBe(1);
    for (let revision = 1; revision <= 3; revision += 1) {
      const review = { ...createTestSessionSnapshot().state.review, stateRevision: revision };
      state.updateSnapshot(
        socket,
        "session-1",
        createTestSessionSnapshot({ stateRevision: revision, review }),
      );
    }
    expect(server.getSubscriberCount()).toBe(0);
  });

  test("wakes an idle SSE reader when a later state revision is published", async () => {
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, { heartbeatMs: 60_000 });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const response = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie } }),
    );
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");

    const pending = reader.read();
    await Bun.sleep(0);
    const review = { ...createTestSessionSnapshot().state.review, stateRevision: 1 };
    expect(
      state.updateSnapshot(
        socket,
        "session-1",
        createTestSessionSnapshot({ stateRevision: 1, review }),
      ),
    ).toBe("updated");

    const delivered = await Promise.race([
      pending,
      Bun.sleep(250).then(() => ({ timeout: true as const })),
    ]);
    expect(delivered).not.toHaveProperty("timeout");
    expect(
      new TextDecoder().decode((delivered as ReadableStreamReadResult<Uint8Array>).value),
    ).toContain("event: state");
    await reader.cancel();
    expect(server.getSubscriberBufferedByteCount()).toBe(0);
  });

  test("streams initial snapshots, state revisions, reconnect recovery, and disconnect cleanup", async () => {
    const { state, socket } = createRegisteredState();
    const server = new BrowserReviewServer(state, { heartbeatMs: 60_000 });
    servers.push(server);
    const cookie = await authorize(server, "session-1", "capability-one");
    const response = await server.handle(
      request("/review-api/session-1/events", { headers: { cookie } }),
    );
    const reader = response!.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: snapshot");
    const id = first.match(/^id: (.+)$/m)?.[1];
    expect(id).toStartWith("v1.");

    const review = { ...createTestSessionSnapshot().state.review, stateRevision: 1 };
    expect(
      state.updateSnapshot(
        socket,
        "session-1",
        createTestSessionSnapshot({ stateRevision: 1, review }),
      ),
    ).toBe("updated");
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(next).toContain("event: state");
    expect(next).toContain('"stateRevision":1');
    await reader.cancel();

    const reconnect = await server.handle(
      request("/review-api/session-1/events", {
        headers: { cookie, "last-event-id": id! },
      }),
    );
    const replay = new TextDecoder().decode((await reconnect!.body!.getReader().read()).value);
    expect(replay).toContain("event: snapshot");
    state.unregisterSocket(socket);
    expect(server.getSubscriberCount()).toBe(0);
  });
});
