import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REVIEW_PATCH_CONTENT_TYPE, reviewResourceId } from "../../core/review/resources";
import {
  encodeReviewEventFrame,
  planReviewEventFrames,
  REVIEW_EVENT_HEARTBEAT_FRAME,
  type ReviewEventTypeV1,
} from "../../session/reviewEventProtocol";
import type { HunkReviewPublicationBodyV1 } from "../../session/reviewHttpProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../session/reviewProtocol";
import { readReviewEvents, ServerSentEventParser, type ReviewStreamEvent } from "./eventReader";

const ADDRESS = { generation: "generation:p1:0", stateRevision: 3 };

/** A publication body with a catalog padded to a chosen size. */
function createTestPublication(padding = 0): HunkReviewPublicationBodyV1 {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: "session-1",
    publication: ADDRESS,
    catalog: {
      generation: ADDRESS.generation,
      fileKeysByRuntimeId: {},
      resources: Array.from({ length: padding }, (_unused, index) => {
        const fileKey = `file:${index}`;
        return {
          id: reviewResourceId({ kind: "patch", fileKey }),
          generation: ADDRESS.generation,
          fileKey,
          kind: "patch" as const,
          contentType: REVIEW_PATCH_CONTENT_TYPE,
        };
      }),
    },
  };
}

/** Frame one event as the daemon does, returning its SSE text. */
function frameTestEvent(type: ReviewEventTypeV1, body: unknown, chunkBytes?: number) {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  return planReviewEventFrames({
    type,
    address: ADDRESS,
    body,
    payload,
    contentDigest: createHash("sha256").update(payload).digest("hex"),
    encodeChunk: (bytes) => Buffer.from(bytes).toString("base64"),
    ...(chunkBytes ? { chunkBytes } : {}),
  })
    .map(encodeReviewEventFrame)
    .join("");
}

/** A stream body delivering `text` in pieces of `pieceSize` characters. */
function createTestBody(text: string, pieceSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += pieceSize) {
        controller.enqueue(bytes.slice(offset, offset + pieceSize));
      }
      controller.close();
    },
  });
}

/** Read every event from one SSE text. */
async function readTestEvents(text: string, pieceSize?: number) {
  const events: ReviewStreamEvent[] = [];
  await readReviewEvents(createTestBody(text, pieceSize), (event) => events.push(event));
  return events;
}

describe("ServerSentEventParser", () => {
  test("splits records across arbitrary boundaries and drops comments", () => {
    const parser = new ServerSentEventParser();
    const text = `${REVIEW_EVENT_HEARTBEAT_FRAME}id: x\nevent: e\ndata: {"a":\ndata: 1}\n\n`;
    const records = [...text].flatMap((character) => parser.push(character));

    expect(records).toEqual([{ id: "x", event: "e", data: '{"a":\n1}' }]);
  });

  test("accepts CRLF line endings", () => {
    expect(new ServerSentEventParser().push("event: e\r\ndata: 1\r\n\r\n")).toEqual([
      { event: "e", data: "1" },
    ]);
  });
});

describe("readReviewEvents", () => {
  test("reads a single-frame publication", async () => {
    const body = createTestPublication();

    const events = await readTestEvents(frameTestEvent("publication", body));

    expect(events).toEqual([{ type: "publication", address: ADDRESS, body }]);
  });

  // Intent: a chunked payload is verified by the shared assembler, not a local loop (C2/C4).
  test("reassembles a chunked publication with heartbeats between frames", async () => {
    const body = createTestPublication(20);
    const framed = frameTestEvent("publication", body, 64);
    const withHeartbeats = framed.replaceAll("\n\n", `\n\n${REVIEW_EVENT_HEARTBEAT_FRAME}`);

    const events = await readTestEvents(withHeartbeats, 13);

    expect(events).toEqual([{ type: "publication", address: ADDRESS, body }]);
  });

  test("refuses a chunked payload that does not hash to its declared digest", async () => {
    const framed = frameTestEvent("publication", createTestPublication(20), 64);
    // Flip one base64 character in the first chunk; the size stays the same.
    const tampered = framed.replace(
      /("data":")(.)/,
      (_match, prefix: string, character: string) => `${prefix}${character === "A" ? "B" : "A"}`,
    );

    await expect(readTestEvents(tampered)).rejects.toThrow();
  });

  test("refuses an unknown frame name", async () => {
    await expect(readTestEvents("event: snapshot\ndata: {}\n\n")).rejects.toThrow("Unknown");
  });

  test("stops after a disconnect", async () => {
    const text =
      frameTestEvent("disconnect", { sessionId: "session-1" }) +
      frameTestEvent("publication", createTestPublication());

    const events = await readTestEvents(text);

    expect(events).toEqual([{ type: "disconnect", address: ADDRESS }]);
  });
});
