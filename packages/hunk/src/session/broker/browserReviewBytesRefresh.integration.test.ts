/**
 * Byte resources and the refresh route, driven with a real server and `fetch`.
 *
 * Security-relevant cases are explicit: bytes are never served as a renderable document, and
 * refresh accepts no arguments, refuses the wrong method, an unauthorized caller, and an
 * oversized body, and coalesces concurrent requests into one reload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import type { DiffFile } from "../../core/changeset/model";
import {
  MAX_REVIEW_BYTES_RESOURCE_BYTES,
  REVIEW_BYTES_CONTENT_TYPE,
  reviewResourceId,
} from "../../core/review/resources";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import {
  connectReviewSession,
  type ReviewSessionHarnessOptions,
} from "../../../../../test/helpers/review-session-harness";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type HunkReviewHttpRoute,
} from "../reviewHttpProtocol";
import type { HunkReviewRefreshResultV1 } from "../reviewProtocol";
import { BrowserReviewServer } from "./browserReviewServer";

const SESSION_ID = "session-bytes-1";
const running: Array<{ review: BrowserReviewServer; server: { stop: (force?: boolean) => void } }> =
  [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** One image-like file whose loader reads exact bytes per side. */
function createTestImageFile(bytes: { old?: Uint8Array; new?: Uint8Array }): DiffFile {
  return {
    ...createTestDiffFile({ id: "logo", path: "logo.png" }),
    byteFetcher: { getBytes: async (side) => bytes[side] ?? null },
  };
}

/** Serve one session over the given files. */
function start(files: DiffFile[], options: ReviewSessionHarnessOptions = {}) {
  const harness = connectReviewSession(files, { sessionId: SESSION_ID, ...options });
  harness.register();
  const review = new BrowserReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server });
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (
    route: HunkReviewHttpRoute,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const { token = reviewProcessCapability().token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token !== null) headers.set(HUNK_REVIEW_CAPABILITY_HEADER, token);
    return fetch(`${origin}${reviewHttpPath(route)}`, { ...rest, headers });
  };
  return { harness, request };
}

describe("browser review surface: byte resources", () => {
  test("catalogs bytes per available side and serves them as inert octet-stream data", async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const { harness, request } = start([createTestImageFile({ old: image, new: image })]);
    const publication = harness.producer.getPublication();
    const fileKey = publication.document.files[0]!.key;
    const bytesIds = publication.resources
      .filter((resource) => resource.kind === "bytes")
      .map((resource) => resource.id);
    expect(bytesIds).toEqual([
      reviewResourceId({ kind: "bytes", fileKey, side: "old" }),
      reviewResourceId({ kind: "bytes", fileKey, side: "new" }),
    ]);

    const response = await request({
      kind: "resource",
      sessionId: SESSION_ID,
      generation: publication.generation,
      resourceId: reviewResourceId({ kind: "bytes", fileKey, side: "new" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(REVIEW_BYTES_CONTENT_TYPE);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });

  test("catalogs nothing without a byte reader and refuses bytes over the preview ceiling", async () => {
    const plain = start([createTestDiffFile({ id: "plain", path: "plain.ts" })]);
    expect(
      plain.harness.producer
        .getPublication()
        .resources.some((resource) => resource.kind === "bytes"),
    ).toBe(false);
    running.splice(0).forEach((entry) => {
      entry.review.close();
      entry.server.stop(true);
    });

    const huge = new Uint8Array(MAX_REVIEW_BYTES_RESOURCE_BYTES + 1);
    const { harness, request } = start([createTestImageFile({ old: huge, new: huge })]);
    const publication = harness.producer.getPublication();
    const response = await request({
      kind: "resource",
      sessionId: SESSION_ID,
      generation: publication.generation,
      resourceId: reviewResourceId({
        kind: "bytes",
        fileKey: publication.document.files[0]!.key,
        side: "new",
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "resource-too-large" });
  });
});

describe("browser review surface: refresh", () => {
  const REFRESH = { kind: "refresh", sessionId: SESSION_ID } as const;

  test("reloads through the session with no arguments and reports the position reached", async () => {
    let calls = 0;
    const { harness, request } = start([createTestDiffFile()], {
      refreshReview: async () => {
        calls += 1;
        const position = harness.producer.getPublicationAddress();
        return { ok: true, ...position };
      },
    });
    const response = await request(REFRESH, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      sessionId: SESSION_ID,
      publication: harness.producer.getPublicationAddress(),
    });
    expect(calls).toBe(1);
  });

  test("refuses arguments, an oversized body, the wrong method, and an unauthorized caller", async () => {
    let calls = 0;
    const { harness, request } = start([createTestDiffFile()], {
      refreshReview: async () => {
        calls += 1;
        return { ok: true, ...harness.producer.getPublicationAddress() };
      },
    });
    const withArguments = await request(REFRESH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "diff" } }),
    });
    expect(withArguments.status).toBe(400);
    expect(await withArguments.json()).toMatchObject({ code: "invalid-request" });

    const oversized = await request(REFRESH, { method: "POST", body: "x".repeat(64 * 1024) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "payload-too-large" });

    const get = await request(REFRESH);
    expect(get.status).toBe(405);
    expect(await get.json()).toMatchObject({ code: "method-not-allowed" });

    const unauthorized = await request(REFRESH, { method: "POST", token: null });
    expect(unauthorized.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("coalesces concurrent refreshes into one reload", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { harness, request } = start([createTestDiffFile()], {
      refreshReview: async (): Promise<HunkReviewRefreshResultV1> => {
        calls += 1;
        await gate;
        return { ok: true, ...harness.producer.getPublicationAddress() };
      },
    });
    const pending = Array.from({ length: 5 }, () => request(REFRESH, { method: "POST" }));
    await Bun.sleep(50);
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(calls).toBe(1);
  });

  test("reports refresh-unavailable when the session cannot reload", async () => {
    const { request } = start([createTestDiffFile()]);
    const response = await request(REFRESH, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "refresh-unavailable" });
  });
});
