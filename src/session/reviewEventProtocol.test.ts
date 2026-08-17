import { describe, expect, test } from "bun:test";
import { nodeReviewDigest } from "../core/reviewDigest";
import { MAX_HUNK_REVIEW_ENVELOPE_BYTES } from "./reviewProtocol";
import {
  encodeReviewEventFrame,
  MAX_REVIEW_EVENT_CHUNKS,
  MAX_REVIEW_EVENT_PAYLOAD_BYTES,
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  parseReviewEventFrameName,
  parseReviewEventId,
  planReviewEventFrames,
  ReviewEventAssembler,
  ReviewEventTooLargeError,
  reviewEventChunkCount,
  reviewEventFrameName,
  reviewEventId,
  type ReviewEventBeginV1,
  type ReviewEventChunkV1,
  type ReviewEventEndV1,
} from "./reviewEventProtocol";

const ADDRESS = { generation: "generation:test:3", stateRevision: 7 };

const encoder = new TextEncoder();

/** Frame one body with a small chunk size, the way a test-configured server does. */
function frame(body: unknown, chunkBytes: number) {
  const payload = encoder.encode(JSON.stringify(body));
  return planReviewEventFrames({
    type: "publication",
    address: ADDRESS,
    body,
    payload,
    contentDigest: nodeReviewDigest(payload),
    encodeChunk: (bytes) => Buffer.from(bytes).toString("base64"),
    chunkBytes,
  });
}

describe("review event names and ids", () => {
  test("round-trips every frame name it can build", () => {
    for (const type of ["publication", "disconnect"] as const) {
      expect(parseReviewEventFrameName(reviewEventFrameName(type))).toEqual({ type });
      for (const phase of ["begin", "chunk", "end"] as const) {
        expect(parseReviewEventFrameName(reviewEventFrameName(type, phase))).toEqual({
          type,
          phase,
        });
      }
    }
  });

  test("refuses a frame name outside the vocabulary", () => {
    expect(parseReviewEventFrameName("publication-middle")).toBeUndefined();
    expect(parseReviewEventFrameName("state")).toBeUndefined();
    expect(parseReviewEventFrameName("")).toBeUndefined();
  });

  test("round-trips the position an event is about", () => {
    expect(parseReviewEventId(reviewEventId("publication", ADDRESS))).toEqual({
      type: "publication",
      address: ADDRESS,
    });
  });

  // A client echoes `Last-Event-ID` back at the server, so the parser is the boundary an
  // attacker-controlled string meets first.
  test("refuses ids that are not this grammar", () => {
    expect(parseReviewEventId("revent:publication:not-a-generation@1")).toBeUndefined();
    expect(parseReviewEventId("revent:state:generation:test:3@1")).toBeUndefined();
    expect(parseReviewEventId("generation:test:3@1")).toBeUndefined();
    expect(
      parseReviewEventId(`revent:publication:generation:test:3@${"9".repeat(40)}`),
    ).toBeUndefined();
    expect(parseReviewEventId(42)).toBeUndefined();
  });
});

describe("review event bounds", () => {
  test("are the protocol's own, not a second set", () => {
    expect(MAX_REVIEW_EVENT_PAYLOAD_BYTES).toBe(MAX_HUNK_REVIEW_ENVELOPE_BYTES);
    expect(MAX_REVIEW_EVENT_CHUNKS).toBeGreaterThan(0);
  });

  test("count an empty payload as one chunk rather than none", () => {
    expect(reviewEventChunkCount(0)).toBe(1);
    expect(reviewEventChunkCount(1)).toBe(1);
  });

  test("refuse a payload larger than the stream carries", () => {
    const payload = new Uint8Array(MAX_REVIEW_EVENT_PAYLOAD_BYTES + 1);
    expect(() =>
      planReviewEventFrames({
        type: "publication",
        address: ADDRESS,
        body: {},
        payload,
        contentDigest: nodeReviewDigest(payload),
        encodeChunk: () => "",
      }),
    ).toThrow(ReviewEventTooLargeError);
  });
});

describe("review event framing", () => {
  test("sends a small event as one frame carrying the body itself", () => {
    const frames = frame({ hello: "world" }, 4096);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("publication");
    expect(frames[0]!.id).toBe(reviewEventId("publication", ADDRESS));
    expect(parseReviewEventFrame(frames[0]!.data)?.payload).toEqual({ hello: "world" });
  });

  // Only a complete event carries an id, so a reconnecting client's `Last-Event-ID` can
  // never name a position inside a half-delivered payload.
  test("ids only the frame that completes a chunked event", () => {
    const frames = frame({ value: "x".repeat(200) }, 32);

    expect(frames.map((entry) => entry.event)).toEqual([
      "publication-begin",
      ...Array.from({ length: frames.length - 2 }, () => "publication-chunk"),
      "publication-end",
    ]);
    expect(frames.slice(0, -1).every((entry) => entry.id === undefined)).toBe(true);
    expect(frames.at(-1)!.id).toBe(reviewEventId("publication", ADDRESS));
  });

  test("declares the same size, digest, and count at both ends of a chunked event", () => {
    const frames = frame({ value: "y".repeat(200) }, 64);
    const begin = parseReviewEventBegin(frames[0]!.data)!;
    const end = parseReviewEventEnd(frames.at(-1)!.data)!;

    expect(begin.chunkCount).toBe(frames.length - 2);
    expect(end.chunkCount).toBe(begin.chunkCount);
    expect(end.contentSize).toBe(begin.contentSize);
    expect(end.contentDigest).toBe(begin.contentDigest);
  });

  test("encodes one frame as a single-line SSE record", () => {
    const text = encodeReviewEventFrame({ id: "revent:x", event: "publication", data: { a: 1 } });

    expect(text).toBe('id: revent:x\nevent: publication\ndata: {"a":1}\n\n');
  });

  // A payload with newlines in it must not be able to terminate its own frame.
  test("cannot be split by a payload that contains newlines", () => {
    const text = encodeReviewEventFrame({ event: "publication", data: { a: "one\ntwo\n\nthree" } });

    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("review event reassembly", () => {
  /** Read one framed event back the way a client does. */
  function assemble(frames: ReturnType<typeof frame>) {
    const begin = parseReviewEventBegin(frames[0]!.data)!;
    const assembler = new ReviewEventAssembler({ begin, digest: nodeReviewDigest });
    for (const entry of frames.slice(1, -1)) {
      const chunk = parseReviewEventChunk(entry.data)!;
      const step = assembler.accept(chunk, new Uint8Array(Buffer.from(chunk.data, "base64")));
      if (!step.ok) {
        return step;
      }
    }
    return assembler.finish(parseReviewEventEnd(frames.at(-1)!.data)!);
  }

  test("reassembles a chunked payload byte for byte", () => {
    const body = { files: Array.from({ length: 40 }, (_unused, index) => `file-${index}`) };
    const result = assemble(frame(body, 48));

    expect(result.ok).toBe(true);
    expect(result.ok && JSON.parse(new TextDecoder().decode(result.bytes))).toEqual(body);
  });

  // Adversarial: bytes that do not hash to what was declared are corruption, and must be
  // reported as corruption rather than as a resource nobody has.
  test("reports altered bytes as an integrity failure", () => {
    const frames = frame({ value: "z".repeat(200) }, 64);
    const chunk = parseReviewEventChunk(frames[1]!.data)!;
    const bytes = new Uint8Array(Buffer.from(chunk.data, "base64"));
    bytes[0] = bytes[0]! ^ 0xff;
    const assembler = new ReviewEventAssembler({
      begin: parseReviewEventBegin(frames[0]!.data)!,
      digest: nodeReviewDigest,
    });

    expect(assembler.accept(chunk, bytes).ok).toBe(true);
    for (const entry of frames.slice(2, -1)) {
      const next = parseReviewEventChunk(entry.data)!;
      assembler.accept(next, new Uint8Array(Buffer.from(next.data, "base64")));
    }
    const finished = assembler.finish(parseReviewEventEnd(frames.at(-1)!.data)!);

    expect(finished).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  test("refuses a chunk belonging to another event", () => {
    const frames = frame({ value: "q".repeat(200) }, 64);
    const chunk = parseReviewEventChunk(frames[1]!.data)!;
    const assembler = new ReviewEventAssembler({
      begin: parseReviewEventBegin(frames[0]!.data)!,
      digest: nodeReviewDigest,
    });

    const step = assembler.accept(
      { ...chunk, eventId: reviewEventId("disconnect", ADDRESS) },
      new Uint8Array(Buffer.from(chunk.data, "base64")),
    );

    expect(step).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  test("refuses an end frame that disagrees with the begin frame", () => {
    const frames = frame({ value: "w".repeat(200) }, 64);
    const assembler = new ReviewEventAssembler({
      begin: parseReviewEventBegin(frames[0]!.data)!,
      digest: nodeReviewDigest,
    });
    for (const entry of frames.slice(1, -1)) {
      const chunk = parseReviewEventChunk(entry.data)!;
      assembler.accept(chunk, new Uint8Array(Buffer.from(chunk.data, "base64")));
    }
    const end = parseReviewEventEnd(frames.at(-1)!.data)!;

    expect(assembler.finish({ ...end, chunkCount: end.chunkCount + 1 })).toMatchObject({
      ok: false,
      code: "resource-integrity",
    });
  });
});

describe("review event envelope parsing", () => {
  const begin: ReviewEventBeginV1 = {
    eventId: reviewEventId("publication", ADDRESS),
    generation: ADDRESS.generation,
    stateRevision: ADDRESS.stateRevision,
    encoding: "base64",
    contentSize: 10,
    contentDigest: "a".repeat(64),
    chunkCount: 1,
  };

  test("accepts a well-formed begin envelope", () => {
    expect(parseReviewEventBegin(begin)).toEqual(begin);
  });

  test("refuses an extra field, an unknown encoding, and a non-canonical digest", () => {
    expect(parseReviewEventBegin({ ...begin, extra: 1 })).toBeUndefined();
    expect(parseReviewEventBegin({ ...begin, encoding: "hex" })).toBeUndefined();
    expect(parseReviewEventBegin({ ...begin, contentDigest: "A".repeat(64) })).toBeUndefined();
  });

  test("refuses a payload or chunk count past the shared ceilings", () => {
    expect(
      parseReviewEventBegin({ ...begin, contentSize: MAX_REVIEW_EVENT_PAYLOAD_BYTES + 1 }),
    ).toBeUndefined();
    expect(
      parseReviewEventBegin({ ...begin, chunkCount: MAX_REVIEW_EVENT_CHUNKS + 1 }),
    ).toBeUndefined();
    expect(parseReviewEventBegin({ ...begin, chunkCount: 0 })).toBeUndefined();
  });

  test("refuses a chunk larger than one window", () => {
    const chunk: ReviewEventChunkV1 = {
      eventId: begin.eventId,
      generation: begin.generation,
      offset: 0,
      byteLength: MAX_REVIEW_EVENT_PAYLOAD_BYTES,
      encoding: "base64",
      data: "",
      contentDigest: begin.contentDigest,
      contentSize: 10,
      eof: true,
    };

    expect(parseReviewEventChunk(chunk)).toBeUndefined();
    expect(parseReviewEventChunk({ ...chunk, byteLength: 10 })).toEqual({
      ...chunk,
      byteLength: 10,
    });
  });

  test("refuses an end envelope missing a field", () => {
    const end: ReviewEventEndV1 = {
      eventId: begin.eventId,
      generation: begin.generation,
      contentSize: 10,
      contentDigest: begin.contentDigest,
      chunkCount: 1,
    };

    expect(parseReviewEventEnd(end)).toEqual(end);
    const { chunkCount: _dropped, ...withoutCount } = end;
    expect(parseReviewEventEnd(withoutCount)).toBeUndefined();
  });
});
