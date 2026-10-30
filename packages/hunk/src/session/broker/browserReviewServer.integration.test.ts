/**
 * The review HTTP surface, driven the way a client drives it: a real server and `fetch`.
 *
 * A real producer publishes a real generation, a real broker state mirrors it, and the
 * review surface is mounted on a real loopback listener. Nothing between the test and the
 * producer is stubbed, so what is asserted here is the contract a browser client will meet
 * — status codes, headers, framing, and the exact codes each failure reports.
 *
 * Expectations are written from the contract rather than captured from the server: the
 * codes, statuses, and frame names below are what the phase promises, and a server that
 * quietly changed one of them fails here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import { nodeReviewDigest } from "../../core/reviewDigest";
import { REVIEW_PATCH_CONTENT_TYPE, reviewResourceId } from "../../core/review/resources";
import {
  connectReviewSession,
  createTestPatchFile,
} from "../../../../../test/helpers/review-session-harness";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  parseReviewEventFrameName,
  ReviewEventAssembler,
  reviewEventId,
} from "../reviewEventProtocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  REVIEW_CAPABILITY_TOKEN_LENGTH,
  reviewHttpPath,
  type HunkReviewHttpRoute,
} from "../reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../reviewProtocol";
import { BrowserReviewServer, type BrowserReviewServerOptions } from "./browserReviewServer";

const SESSION_ID = "session-http-1";
const ACTOR = { clientId: "test-client", kind: "browser" } as const;

const running: Array<{ review: BrowserReviewServer; server: { stop: (force?: boolean) => void } }> =
  [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** Mount the review surface on a real loopback listener. */
function serve(
  harness: ReturnType<typeof connectReviewSession>,
  options: BrowserReviewServerOptions = {},
) {
  const review = new BrowserReviewServer(harness.state, options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server });
  return { review, origin: `http://127.0.0.1:${server.port}` };
}

/** Connect a session, register it, and mount the surface over it. */
function start(
  files = [createTestPatchFile("alpha", 4)],
  options: BrowserReviewServerOptions = {},
) {
  const harness = connectReviewSession(files, { sessionId: SESSION_ID });
  harness.register();
  return { harness, ...serve(harness, options) };
}

/** The capability the session in this process registered with. */
function capability() {
  return reviewProcessCapability().token;
}

function url(origin: string, route: HunkReviewHttpRoute) {
  return `${origin}${reviewHttpPath(route)}`;
}

/** Request one review route with the capability presented the way a client presents it. */
function request(
  origin: string,
  route: HunkReviewHttpRoute,
  init: RequestInit & { token?: string | null } = {},
) {
  const { token = capability(), ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) {
    headers.set(HUNK_REVIEW_CAPABILITY_HEADER, token);
  }
  return fetch(url(origin, route), { ...rest, headers });
}

/** The patch resource of the session's first file. */
function firstPatchRoute(harness: ReturnType<typeof connectReviewSession>): HunkReviewHttpRoute {
  const publication = harness.producer.getPublication();
  return {
    kind: "resource",
    sessionId: SESSION_ID,
    generation: publication.generation,
    resourceId: reviewResourceId({ kind: "patch", fileKey: publication.document.files[0]!.key }),
  };
}

describe("browser review surface: authorization", () => {
  test("serves the publication to a caller holding the capability", async () => {
    const { harness, origin } = start();

    const response = await request(origin, { kind: "publication", sessionId: SESSION_ID });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      publication: { generation: harness.producer.getPublication().generation, stateRevision: 0 },
    });
    expect(body.catalog.resources.length).toBeGreaterThan(0);
  });

  test("refuses a request with no capability at all", async () => {
    const { origin } = start();

    const response = await request(
      origin,
      { kind: "publication", sessionId: SESSION_ID },
      { token: null },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  // A wrong capability and a malformed one are the same answer: nothing about the failure
  // says which part of it was wrong.
  test("answers a wrong capability exactly as it answers a malformed one", async () => {
    const { origin } = start();
    const route = { kind: "publication", sessionId: SESSION_ID } as const;

    const wrong = await request(origin, route, {
      token: "a".repeat(REVIEW_CAPABILITY_TOKEN_LENGTH),
    });
    const malformed = await request(origin, route, { token: "short" });

    expect(wrong.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(await wrong.json()).toEqual(await malformed.json());
  });

  // Existence must not leak: an unknown session answers unauthorized, not "not found".
  test("does not reveal whether an unaddressed session exists", async () => {
    const { origin } = start();

    const response = await request(origin, { kind: "publication", sessionId: "session-other" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  test("never echoes the capability back in a response", async () => {
    const { harness, origin } = start();

    const responses = await Promise.all([
      request(origin, { kind: "publication", sessionId: SESSION_ID }),
      request(origin, firstPatchRoute(harness)),
    ]);

    for (const response of responses) {
      expect(await response.text()).not.toContain(capability());
      response.headers.forEach((value) => {
        expect(value).not.toContain(capability());
      });
    }
  });

  test("carries the security headers every response is required to have", async () => {
    const { origin } = start();

    const response = await request(origin, { kind: "publication", sessionId: SESSION_ID });

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("declines paths that are not review routes", async () => {
    const { origin } = start();

    const outside = await fetch(`${origin}/health`);
    const inside = await fetch(`${origin}/review-api/session-http-1/snapshot`, {
      headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: capability() },
    });

    expect(outside.status).toBe(404);
    expect(inside.status).toBe(400);
    expect(await inside.json()).toMatchObject({ code: "invalid-request" });
  });
});

describe("browser review surface: local only", () => {
  test("refuses a request whose Host is not loopback", async () => {
    const { origin } = start();

    const response = await fetch(url(origin, { kind: "publication", sessionId: SESSION_ID }), {
      headers: { host: "review.example.com", [HUNK_REVIEW_CAPABILITY_HEADER]: capability() },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden-origin" });
  });

  test("refuses a cross-origin browser request", async () => {
    const { origin } = start();

    const response = await request(
      origin,
      { kind: "publication", sessionId: SESSION_ID },
      { headers: { origin: "http://evil.example" } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden-origin" });
  });

  test("accepts its own origin", async () => {
    const { origin } = start();

    const response = await request(
      origin,
      { kind: "publication", sessionId: SESSION_ID },
      { headers: { origin } },
    );

    expect(response.status).toBe(200);
  });

  test("refuses a route reached with the wrong method", async () => {
    const { origin } = start();

    const response = await request(
      origin,
      { kind: "publication", sessionId: SESSION_ID },
      { method: "POST" },
    );

    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ code: "method-not-allowed" });
  });
});

describe("browser review surface: resources", () => {
  test("serves a whole resource verified through the daemon's own read path", async () => {
    const { harness, origin } = start();

    const response = await request(origin, firstPatchRoute(harness));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(REVIEW_PATCH_CONTENT_TYPE);
    expect(await response.text()).toBe(harness.producer.getPublication().document.files[0]!.patch);
  });

  test("serves one requested window as a partial response", async () => {
    const { harness, origin } = start();
    const patch = harness.producer.getPublication().document.files[0]!.patch;

    const response = await request(origin, firstPatchRoute(harness), {
      headers: { range: "bytes=4-9" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 4-9/${patch.length}`);
    expect(await response.text()).toBe(patch.slice(4, 10));
  });

  test("refuses a malformed range before reading anything", async () => {
    const { harness, origin } = start();
    const before = harness.sent.length;

    const response = await request(origin, firstPatchRoute(harness), {
      headers: { range: "items=0-1" },
    });

    expect(response.status).toBe(416);
    expect(harness.sent).toHaveLength(before);
  });

  test("refuses a range that starts past the end", async () => {
    const { harness, origin } = start();
    const patch = harness.producer.getPublication().document.files[0]!.patch;

    const response = await request(origin, firstPatchRoute(harness), {
      headers: { range: `bytes=${patch.length}-` },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${patch.length}`);
  });

  // A file with nothing in its patch still has a patch resource, and a reader asking for
  // any part of it must be told so rather than handed an empty success.
  test("serves a zero-length resource, and refuses any range within it", async () => {
    const { harness, origin } = start([{ ...createTestDiffFile({ id: "empty" }), patch: "" }]);
    const route = firstPatchRoute(harness);

    const whole = await request(origin, route);
    const ranged = await request(origin, route, { headers: { range: "bytes=0-" } });

    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe("");
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });

  test("reports a resource the generation does not offer as unknown", async () => {
    const { harness, origin } = start();

    const response = await request(origin, {
      ...firstPatchRoute(harness),
      resourceId: reviewResourceId({ kind: "patch", fileKey: "file:deadbeef" }),
    } as HunkReviewHttpRoute);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "unknown-resource" });
  });

  // The distinction the audit insisted on: content that does not match its measurement is
  // corruption, and must never be reported as a resource nobody has.
  test("reports corrupted content as an integrity failure, not as unknown", async () => {
    const harness = connectReviewSession([createTestPatchFile("alpha", 4)], {
      sessionId: SESSION_ID,
      corruptResourceChunks: true,
    });
    harness.register();
    const { origin } = serve(harness);

    const response = await request(origin, firstPatchRoute(harness));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "resource-integrity" });
  });

  test("reports a read against a retired generation as stale", async () => {
    const { harness, origin } = start();
    const route = firstPatchRoute(harness);
    const registration = harness.register();
    harness.producer.publish({
      files: harness.bootstrap.changeset.files,
      sourceLabel: harness.bootstrap.changeset.sourceLabel,
    });
    harness.register(registration);

    const response = await request(origin, route);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale-generation" });
  });
});

describe("browser review surface: actions", () => {
  /** Post one action envelope the way a client composes it. */
  function postAction(origin: string, body: unknown, init: RequestInit = {}) {
    return request(
      origin,
      { kind: "actions", sessionId: SESSION_ID },
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(init.headers as object) },
        body: JSON.stringify(body),
        ...init,
      },
    );
  }

  test("authorizes before admitting an action to the shared body control", async () => {
    let admissions = 0;
    const { origin } = start(undefined, {
      handleActionControl: async (_request, handler) => {
        admissions += 1;
        return handler(new Uint8Array());
      },
    });

    const response = await postAction(
      origin,
      {
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        generation: "generation:unused",
        actor: ACTOR,
        action: { type: "filter/set", filter: "alpha" },
      },
      { token: null } as RequestInit,
    );

    expect(response.status).toBe(401);
    expect(admissions).toBe(0);
  });

  test("parses authorized action bytes once through the injected shared control", async () => {
    let admissions = 0;
    let bodyWasConsumedBeforeAdmission = false;
    const { harness, origin } = start(undefined, {
      handleActionControl: async (request, handler) => {
        admissions += 1;
        bodyWasConsumedBeforeAdmission = request.bodyUsed;
        return handler(new Uint8Array(await request.arrayBuffer()));
      },
    });
    const generation = harness.producer.getPublication().generation;

    const response = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation,
      actor: ACTOR,
      action: { type: "filter/set", filter: "bounded" },
    });

    expect(response.status).toBe(200);
    expect(admissions).toBe(1);
    expect(bodyWasConsumedBeforeAdmission).toBe(false);
    expect(harness.producer.getReviewState()?.filter).toBe("bounded");
  });

  test("applies one action at the producer and reports where the review landed", async () => {
    const { harness, origin } = start();
    const generation = harness.producer.getPublication().generation;

    const response = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation,
      actor: ACTOR,
      action: { type: "filter/set", filter: "alpha" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, generation });
    expect(harness.producer.getReviewState()?.filter).toBe("alpha");
  });

  test("refuses an envelope this protocol cannot express", async () => {
    const { harness, origin } = start();

    const response = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation: harness.producer.getPublication().generation,
      actor: ACTOR,
      action: { type: "filter/set", filter: "alpha" },
      unexpected: true,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid-request" });
  });

  // A vocabulary this build does not have is a different answer from a malformed one: one
  // calls for an upgrade, the other for a fix.
  test("distinguishes an action it does not know from one it cannot parse", async () => {
    const { harness, origin } = start();
    const generation = harness.producer.getPublication().generation;

    const unsupported = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation,
      actor: ACTOR,
      action: { type: "notes/archive-user", noteId: "user:1" },
    });
    const invalid = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation,
      actor: ACTOR,
      action: { type: "filter/set" },
    });

    expect(await unsupported.json()).toMatchObject({ code: "unsupported-action" });
    expect(await invalid.json()).toMatchObject({ code: "invalid-request" });
  });

  test("reports an action addressed to a generation the session left", async () => {
    const { origin } = start();

    const response = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation: "generation:integration:99",
      actor: ACTOR,
      action: { type: "filter/set", filter: "alpha" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale-generation" });
  });

  test("reports a semantic rejection with the producer's own code", async () => {
    const { harness, origin } = start();

    const response = await postAction(origin, {
      protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
      generation: harness.producer.getPublication().generation,
      actor: ACTOR,
      action: { type: "selection/select-file", fileKey: "file:deadbeef" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "file-not-found" });
  });

  test("refuses a body that was not sent as JSON", async () => {
    const { harness, origin } = start();

    const response = await postAction(
      origin,
      {
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        generation: harness.producer.getPublication().generation,
        actor: ACTOR,
        action: { type: "filter/set", filter: "alpha" },
      },
      { headers: { "content-type": "text/plain" } },
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "unsupported-media-type" });
  });
});

/**
 * Read frames off a live stream until the wanted number of complete events has arrived.
 *
 * Completeness is read off the protocol rather than counted here: only the frame that
 * finishes an event carries an `id`, so a reader knows where an event ends without knowing
 * whether it was chunked.
 */
async function readEvents(response: Response, events: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ id?: string; event: string; data: unknown }> = [];
  let complete = 0;
  let buffer = "";
  while (complete < events) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = record.split("\n");
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event && data !== undefined) {
        frames.push({ ...(id ? { id } : {}), event, data: JSON.parse(data) as unknown });
        complete += id ? 1 : 0;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return frames;
}

describe("browser review surface: events", () => {
  test("opens with the publication the review is at", async () => {
    const { harness, origin } = start();
    const address = harness.producer.getPublicationAddress();

    const response = await request(origin, { kind: "events", sessionId: SESSION_ID });
    const [frame] = await readEvents(response, 1);

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(frame!.event).toBe("publication");
    expect(frame!.id).toBe(reviewEventId("publication", address));
    expect(parseReviewEventFrame(frame!.data)?.payload).toMatchObject({
      sessionId: SESSION_ID,
      publication: address,
    });
  });

  test("sends a further event when the session publishes a new position", async () => {
    const { harness, origin } = start();

    const response = await request(origin, { kind: "events", sessionId: SESSION_ID });
    const pending = readEvents(response, 2);
    harness.producer.applyIntent({ type: "filter/set", filter: "beta" });
    harness.publishSnapshot();
    const frames = await pending;

    expect(frames.map((frame) => frame.event)).toEqual(["publication", "publication"]);
    expect(parseReviewEventFrame(frames[1]!.data)?.stateRevision).toBeGreaterThan(
      parseReviewEventFrame(frames[0]!.data)!.stateRevision,
    );
  });

  // C4: a payload larger than one chunk is framed as begin/chunks/end, and reassembles to
  // exactly the body a single frame would have carried.
  test("chunks a large event and reassembles it byte for byte", async () => {
    const { harness, origin } = start(
      Array.from({ length: 6 }, (_unused, index) => createTestPatchFile(`file${index}`, 2)),
      { eventChunkBytes: 128 },
    );

    const response = await request(origin, { kind: "events", sessionId: SESSION_ID });
    const frames = await readEvents(response, 1);

    const phases = frames.map((frame) => parseReviewEventFrameName(frame.event));
    expect(phases[0]).toEqual({ type: "publication", phase: "begin" });
    expect(phases.at(-1)).toEqual({ type: "publication", phase: "end" });
    expect(phases.slice(1, -1).every((phase) => phase?.phase === "chunk")).toBe(true);
    // Only the frame that finishes the event is resumable.
    expect(frames.filter((frame) => frame.id !== undefined)).toHaveLength(1);

    const begin = parseReviewEventBegin(frames[0]!.data)!;
    expect(begin.chunkCount).toBe(frames.length - 2);
    const assembler = new ReviewEventAssembler({ begin, digest: nodeReviewDigest });
    for (const frame of frames.slice(1, -1)) {
      const chunk = parseReviewEventChunk(frame.data)!;
      expect(assembler.accept(chunk, new Uint8Array(Buffer.from(chunk.data, "base64"))).ok).toBe(
        true,
      );
    }
    const assembled = assembler.finish(parseReviewEventEnd(frames.at(-1)!.data)!);

    expect(assembled.ok).toBe(true);
    expect(assembled.ok && JSON.parse(new TextDecoder().decode(assembled.bytes))).toMatchObject({
      sessionId: SESSION_ID,
      publication: harness.producer.getPublicationAddress(),
    });
  });

  test("ends the stream when the session goes away", async () => {
    const { harness, origin } = start();

    const response = await request(origin, { kind: "events", sessionId: SESSION_ID });
    const pending = readEvents(response, 2);
    harness.state.unregisterSocket(harness.socket);
    harness.state.pruneStaleSessions({ ttlMs: 0 });
    const frames = await pending;

    expect(frames.map((frame) => frame.event)).toEqual(["publication", "disconnect"]);
  });

  test("refuses more streams than it will keep open for one review", async () => {
    const { origin } = start(undefined, { maxStreamsPerSession: 1 });

    const first = await request(origin, { kind: "events", sessionId: SESSION_ID });
    const second = await request(origin, { kind: "events", sessionId: SESSION_ID });

    expect(first.status).toBe(200);
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({ code: "too-many-streams" });
    await first.body?.cancel();
  });

  // A session the daemon knows but whose review it has never mirrored — an older build, or
  // one still loading — is authorized and has nothing to stream.
  test("refuses a stream for a session that publishes no review", async () => {
    const harness = connectReviewSession([createTestPatchFile("alpha", 3)], {
      sessionId: SESSION_ID,
    });
    const registration = harness.register();
    const publication = harness.producer.getPublication();
    harness.state.registerSession(
      harness.socket,
      JSON.parse(
        JSON.stringify({
          ...registration,
          sessionId: "session-http-quiet",
          info: { ...registration.info, reviewCatalog: undefined },
        }),
      ),
      JSON.parse(
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          state: {
            selectedHunkIndex: 0,
            showAgentNotes: false,
            liveCommentCount: 0,
            liveComments: [],
            selectedFilePath: publication.document.files[0]?.path,
          },
        }),
      ),
    );
    const { origin } = serve(harness);

    const events = await request(origin, { kind: "events", sessionId: "session-http-quiet" });
    const snapshot = await request(origin, {
      kind: "publication",
      sessionId: "session-http-quiet",
    });

    expect(events.status).toBe(409);
    expect(await events.json()).toMatchObject({ code: "no-publication" });
    expect(snapshot.status).toBe(409);
  });
});
