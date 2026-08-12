import { describe, expect, test } from "bun:test";
import { ReviewChunkAssembler } from "./resourceAssembly";
import { REVIEW_RESOURCE_CHUNK_BYTES, type ReviewResourceChunkV1 } from "./resources";

const GENERATION = "generation:p1:0";
const RESOURCE_ID = "resource:patch:file:abcdef";

/** A digest function whose answer is stable and inspectable, so tests never hash for real. */
function fakeDigest(expected: string) {
  return () => expected;
}

const DIGEST = "a".repeat(64);

function chunk(overrides: Partial<ReviewResourceChunkV1> = {}): ReviewResourceChunkV1 {
  return {
    generation: GENERATION,
    resourceId: RESOURCE_ID,
    offset: 0,
    byteLength: 0,
    encoding: "base64",
    data: "",
    contentDigest: DIGEST,
    contentSize: 0,
    eof: true,
    ...overrides,
  };
}

function assembler(
  options: { maxBytes?: number; expected?: { byteLength: number; digest: string } } = {},
) {
  return new ReviewChunkAssembler({
    resourceId: RESOURCE_ID,
    generation: GENERATION,
    digest: fakeDigest(DIGEST),
    maxBytes: options.maxBytes ?? REVIEW_RESOURCE_CHUNK_BYTES * 8,
    ...(options.expected ? { expected: options.expected } : {}),
  });
}

describe("ReviewChunkAssembler", () => {
  // Intent: the ordinary multi-chunk read reassembles in order and verifies once.
  test("assembles sequential chunks into the whole resource", () => {
    const assembly = assembler();
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);

    expect(
      assembly.accept({
        chunk: chunk({ byteLength: 3, contentSize: 5, eof: false }),
        bytes: first,
      }),
    ).toEqual({ ok: true, done: false });
    expect(assembly.nextOffset).toBe(3);
    expect(assembly.remainingBytes).toBe(2);
    expect(
      assembly.accept({
        chunk: chunk({ offset: 3, byteLength: 2, contentSize: 5, eof: true }),
        bytes: second,
      }),
    ).toEqual({ ok: true, done: true });

    const finished = assembly.finish();
    expect(finished).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  });

  // Intent: a zero-length resource has no terminator other than `eof`, so one empty chunk
  // must be a complete, verified read rather than a stalled one.
  test("accepts a zero-length resource as one empty end-of-stream chunk", () => {
    const assembly = assembler();

    expect(assembly.accept({ chunk: chunk(), bytes: new Uint8Array() })).toEqual({
      ok: true,
      done: true,
    });
    expect(assembly.finish()).toEqual({ ok: true, bytes: new Uint8Array() });
  });

  // Intent: an empty chunk that does not end the stream would loop a reader forever.
  test("refuses an empty chunk that makes no progress", () => {
    const assembly = assembler();

    const step = assembly.accept({
      chunk: chunk({ contentSize: 4, eof: false }),
      bytes: new Uint8Array(),
    });
    expect(step).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  // Intent: a chunk that skips or repeats bytes is a range failure, not a corrupt one.
  test("refuses a chunk that does not start where the last one ended", () => {
    const assembly = assembler();
    assembly.accept({
      chunk: chunk({ byteLength: 2, contentSize: 4, eof: false }),
      bytes: new Uint8Array([1, 2]),
    });

    expect(
      assembly.accept({
        chunk: chunk({ offset: 3, byteLength: 1, contentSize: 4, eof: true }),
        bytes: new Uint8Array([4]),
      }),
    ).toMatchObject({ ok: false, code: "invalid-range" });
  });

  // Intent: the whole-resource facts are declared by every chunk and may never change.
  test("refuses a stream that changes its declared digest partway", () => {
    const assembly = assembler();
    assembly.accept({
      chunk: chunk({ byteLength: 2, contentSize: 4, eof: false }),
      bytes: new Uint8Array([1, 2]),
    });

    expect(
      assembly.accept({
        chunk: chunk({
          offset: 2,
          byteLength: 2,
          contentSize: 4,
          contentDigest: "b".repeat(64),
          eof: true,
        }),
        bytes: new Uint8Array([3, 4]),
      }),
    ).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  // Intent: a resource is refused for size before its bytes are retained, not after.
  test("refuses a resource that declares more than the reader's bound", () => {
    const assembly = assembler({ maxBytes: 3 });

    expect(
      assembly.accept({
        chunk: chunk({ byteLength: 2, contentSize: 9, eof: false }),
        bytes: new Uint8Array([1, 2]),
      }),
    ).toMatchObject({ ok: false, code: "resource-too-large" });
  });

  // Intent: the digest is recomputed over the assembled bytes, never trusted from the wire.
  test("refuses bytes that do not hash to the declared digest", () => {
    const assembly = new ReviewChunkAssembler({
      resourceId: RESOURCE_ID,
      generation: GENERATION,
      digest: fakeDigest("c".repeat(64)),
      maxBytes: 1024,
    });
    assembly.accept({
      chunk: chunk({ byteLength: 1, contentSize: 1, eof: true }),
      bytes: new Uint8Array([7]),
    });

    expect(assembly.finish()).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  // Intent: a measured descriptor pins what the read must produce before it starts.
  test("holds a stream to the measurements a descriptor already declared", () => {
    const assembly = assembler({ expected: { byteLength: 2, digest: DIGEST } });

    expect(assembly.declaredSize).toBe(2);
    expect(
      assembly.accept({
        chunk: chunk({ byteLength: 3, contentSize: 3, eof: true }),
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  // Intent: a chunk routed from another resource or generation is never silently absorbed.
  test("refuses a chunk from another resource", () => {
    const assembly = assembler();

    expect(
      assembly.accept({
        chunk: chunk({ resourceId: "resource:patch:file:999999", byteLength: 1, contentSize: 1 }),
        bytes: new Uint8Array([1]),
      }),
    ).toMatchObject({ ok: false, code: "resource-integrity" });
  });

  // Intent: the first failure is what a caller reports, not whatever the next call notices.
  test("keeps reporting the first failure once one has occurred", () => {
    const assembly = assembler({ maxBytes: 1 });
    const first = assembly.accept({
      chunk: chunk({ byteLength: 1, contentSize: 5, eof: false }),
      bytes: new Uint8Array([1]),
    });

    expect(first).toMatchObject({ code: "resource-too-large" });
    expect(assembly.finish()).toEqual(first as never);
  });

  // Intent: assembling before the stream ends is a failure, never a truncated success.
  test("refuses to finish an unterminated stream", () => {
    const assembly = assembler();
    assembly.accept({
      chunk: chunk({ byteLength: 1, contentSize: 4, eof: false }),
      bytes: new Uint8Array([1]),
    });

    expect(assembly.finish()).toMatchObject({ ok: false, code: "resource-integrity" });
  });
});
