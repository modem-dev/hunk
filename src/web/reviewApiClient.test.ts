import { describe, expect, test } from "bun:test";
import { REVIEW_RESOURCE_CHUNK_BYTES, reviewResourceId } from "../core/review/resources";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import {
  encodeReviewEventFrame,
  planReviewEventFrames,
  reviewEventId,
} from "../session/reviewEventProtocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewContentMeasurementHeaders,
  reviewHttpPath,
  reviewUrl,
  type HunkReviewPublicationBodyV1,
} from "../session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../session/reviewProtocol";
import { parseBrowserReviewLocation, BrowserReviewApiClient } from "./reviewApiClient";
import { browserReviewDigest } from "./reviewDigest";

const ORIGIN = "http://127.0.0.1:4300";
const SESSION_ID = "session-1";
const GENERATION = "generation:p1:3";
const CAPABILITY = "c".repeat(43);
const FILE_KEY = "file:00000001";
const RESOURCE_ID = reviewResourceId({ kind: "patch", fileKey: FILE_KEY });

const PUBLICATION: HunkReviewPublicationBodyV1 = {
  protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
  sessionId: SESSION_ID,
  publication: { generation: GENERATION, stateRevision: 7 },
  catalog: {
    generation: GENERATION,
    fileKeysByRuntimeId: { "file-1": FILE_KEY },
    resources: [
      {
        id: RESOURCE_ID,
        generation: GENERATION,
        fileKey: FILE_KEY,
        kind: "patch",
        contentType: "text/x-diff; charset=utf-8",
      },
    ],
  },
};

/** Build a client over a `fetch` that answers from a table of route handlers. */
function clientOver(handle: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const client = new BrowserReviewApiClient({
    origin: ORIGIN,
    sessionId: SESSION_ID,
    capability: CAPABILITY,
    digest: browserReviewDigest,
    fetch: Object.assign(
      async (input: unknown, init: RequestInit | undefined) => {
        const request = new Request(input as string, init);
        requests.push(request);
        return await handle(request);
      },
      { preconnect: () => undefined },
    ) as unknown as typeof globalThis.fetch,
  });
  return { client, requests };
}

/** Serve one resource the way the surface does: capped windows plus the measurement. */
function serveResource(bytes: Uint8Array, options: { measure?: boolean } = {}) {
  return (request: Request) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(
      range ? Number(range[2]) : bytes.byteLength - 1,
      bytes.byteLength - 1,
      start + REVIEW_RESOURCE_CHUNK_BYTES - 1,
    );
    return new Response(bytes.slice(start, end + 1), {
      status: range ? 206 : 200,
      headers:
        options.measure === false
          ? {}
          : reviewContentMeasurementHeaders({
              byteLength: bytes.byteLength,
              digest: browserReviewDigest(bytes),
            }),
    });
  };
}

describe("parseBrowserReviewLocation", () => {
  test("reads the session and capability out of a review URL", () => {
    const url = new URL(reviewUrl(ORIGIN, SESSION_ID, CAPABILITY));

    expect(parseBrowserReviewLocation(url)).toEqual({
      origin: ORIGIN,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
    });
  });

  test("refuses a URL carrying no capability", () => {
    expect(parseBrowserReviewLocation(new URL(`${ORIGIN}/review/${SESSION_ID}/`))).toBeUndefined();
  });

  test("refuses a malformed path as an answer, not an exception", () => {
    // "%E0%A4%A" is truncated percent-encoding: decodeURIComponent throws on it. A
    // hand-edited link must land on the invalid-link message, so the parser answers
    // undefined instead of aborting whoever mounted the page.
    const url = new URL(reviewUrl(ORIGIN, SESSION_ID, CAPABILITY));
    const malformed = { ...url, origin: url.origin, hash: url.hash, pathname: "/review/%E0%A4%A/" };

    expect(parseBrowserReviewLocation(malformed)).toBeUndefined();
  });
});

describe("BrowserReviewApiClient.readPublication", () => {
  test("presents the capability in a header and nowhere else", async () => {
    const { client, requests } = clientOver(() => Response.json(PUBLICATION));

    await client.readPublication();

    const request = requests[0]!;
    expect(request.headers.get(HUNK_REVIEW_CAPABILITY_HEADER)).toBe(CAPABILITY);
    expect(request.url).not.toContain(CAPABILITY);
    expect(request.url).toBe(
      `${ORIGIN}${reviewHttpPath({ kind: "publication", sessionId: SESSION_ID })}`,
    );
  });

  test("accepts a publication the wire protocol would accept", async () => {
    const { client } = clientOver(() => Response.json(PUBLICATION));

    expect(await client.readPublication()).toEqual({ ok: true, value: PUBLICATION });
  });

  test("refuses a publication whose catalog belongs to another generation", async () => {
    const { client } = clientOver(() =>
      Response.json({
        ...PUBLICATION,
        catalog: { ...PUBLICATION.catalog, generation: "generation:p1:4" },
      }),
    );

    expect(await client.readPublication()).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("reports the code and message the surface sent", async () => {
    const { client } = clientOver(() =>
      Response.json(
        { ok: false, code: "no-publication", message: "not yet", currentGeneration: GENERATION },
        { status: 409 },
      ),
    );

    expect(await client.readPublication()).toEqual({
      ok: false,
      code: "no-publication",
      message: "not yet",
      currentGeneration: GENERATION,
    });
  });

  test("falls back to the shared catalog when a refusal carries no body", async () => {
    const { client } = clientOver(() => new Response(null, { status: 416 }));

    expect(await client.readPublication()).toEqual({
      ok: false,
      code: "invalid-range",
      message: reviewErrorMessage("invalid-range"),
    });
  });
});

describe("BrowserReviewApiClient.readResource", () => {
  const descriptor = { id: RESOURCE_ID, generation: GENERATION, kind: "patch" } as const;

  test("joins several windows into one verified resource", async () => {
    const bytes = new Uint8Array(REVIEW_RESOURCE_CHUNK_BYTES * 2 + 17);
    crypto.getRandomValues(bytes);
    const { client, requests } = clientOver(serveResource(bytes));

    const result = await client.readResource(descriptor);

    expect(result).toEqual({ ok: true, value: bytes });
    expect(requests).toHaveLength(3);
    // The first window asks for no range at all, so an empty resource is readable.
    expect(requests[0]!.headers.get("range")).toBeNull();
    expect(requests[1]!.headers.get("range")).toBe(
      `bytes=${REVIEW_RESOURCE_CHUNK_BYTES}-${REVIEW_RESOURCE_CHUNK_BYTES * 2 - 1}`,
    );
  });

  test("reads a zero-length resource, which has no satisfiable range", async () => {
    const { client, requests } = clientOver(serveResource(new Uint8Array(0)));

    expect(await client.readResource(descriptor)).toEqual({ ok: true, value: new Uint8Array(0) });
    expect(requests).toHaveLength(1);
  });

  test("refuses bytes that do not hash to the digest they were served with", async () => {
    const bytes = new TextEncoder().encode("the patch");
    // The same length, so what fails is the digest rather than the arithmetic before it.
    const { client } = clientOver(
      () =>
        new Response(new TextEncoder().encode("the p4tch"), {
          headers: reviewContentMeasurementHeaders({
            byteLength: bytes.byteLength,
            digest: browserReviewDigest(bytes),
          }),
        }),
    );

    expect(await client.readResource(descriptor)).toMatchObject({
      ok: false,
      code: "resource-integrity",
    });
  });

  test("refuses a window that changes the measurement mid-stream", async () => {
    const first = new Uint8Array(REVIEW_RESOURCE_CHUNK_BYTES);
    const whole = new Uint8Array(REVIEW_RESOURCE_CHUNK_BYTES * 2);
    let window = 0;
    const { client } = clientOver(() => {
      const bytes = whole.slice(0, REVIEW_RESOURCE_CHUNK_BYTES);
      const measurement =
        window === 0
          ? { byteLength: whole.byteLength, digest: browserReviewDigest(whole) }
          : { byteLength: whole.byteLength, digest: browserReviewDigest(first) };
      window += 1;
      return new Response(bytes, {
        status: 206,
        headers: reviewContentMeasurementHeaders(measurement),
      });
    });

    expect(await client.readResource(descriptor)).toMatchObject({
      ok: false,
      code: "resource-integrity",
    });
  });

  test("refuses bytes served without a measurement to verify them against", async () => {
    const { client } = clientOver(serveResource(new TextEncoder().encode("x"), { measure: false }));

    expect(await client.readResource(descriptor)).toMatchObject({
      ok: false,
      code: "resource-integrity",
    });
  });
});

describe("BrowserReviewApiClient.streamEvents", () => {
  /** Serve one event stream built by the shared framer, as the surface builds it. */
  function serveEvents(body: unknown, chunkBytes?: number) {
    const payload = new TextEncoder().encode(JSON.stringify(body));
    const frames = planReviewEventFrames({
      type: "publication",
      address: PUBLICATION.publication,
      body,
      payload,
      contentDigest: browserReviewDigest(payload),
      encodeChunk: (bytes) => btoa(String.fromCharCode(...bytes)),
      ...(chunkBytes === undefined ? {} : { chunkBytes }),
    });
    return new Response(new TextEncoder().encode(frames.map(encodeReviewEventFrame).join("")), {
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("delivers one whole publication from a single-frame event", async () => {
    const { client } = clientOver(() => serveEvents(PUBLICATION));
    const seen: unknown[] = [];

    await client.streamEvents({ onPublication: (body) => seen.push(body) });

    expect(seen).toEqual([PUBLICATION]);
  });

  test("reassembles a chunked publication through the shared assembler", async () => {
    const { client } = clientOver(() => serveEvents(PUBLICATION, 32));
    const seen: unknown[] = [];

    await client.streamEvents({ onPublication: (body) => seen.push(body) });

    expect(seen).toEqual([PUBLICATION]);
  });

  test("reports a chunked payload whose bytes were tampered with", async () => {
    const { client } = clientOver(() => {
      const original = serveEvents(PUBLICATION, 32);
      return original.text().then(
        (text) =>
          new Response(text.replace(/"data":"([A-Za-z0-9+/=]{4})/, '"data":"AAAA'), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
    });
    const failures: string[] = [];

    await client.streamEvents({
      onPublication: () => undefined,
      onError: (failure) => failures.push(failure.code),
    });

    expect(failures).toContain("resource-integrity");
  });

  test("ignores the heartbeat, which is a comment rather than an event", async () => {
    const { client } = clientOver(
      () =>
        new Response(
          new TextEncoder().encode(
            `: hunk-review-heartbeat\n\n${encodeReviewEventFrame({
              id: reviewEventId("disconnect", PUBLICATION.publication),
              event: "disconnect",
              data: {
                eventId: reviewEventId("disconnect", PUBLICATION.publication),
                generation: GENERATION,
                stateRevision: PUBLICATION.publication.stateRevision,
                payload: { sessionId: SESSION_ID },
              },
            })}`,
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    let disconnected = false;

    await client.streamEvents({
      onPublication: () => undefined,
      onDisconnect: () => {
        disconnected = true;
      },
    });

    expect(disconnected).toBe(true);
  });

  test("reports a stream the surface refused to open", async () => {
    const { client } = clientOver(() =>
      Response.json({ ok: false, code: "too-many-streams", message: "full" }, { status: 503 }),
    );
    const failures: string[] = [];

    await client.streamEvents({
      onPublication: () => undefined,
      onError: (failure) => failures.push(failure.code),
    });

    expect(failures).toEqual(["too-many-streams"]);
  });
});
