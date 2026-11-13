import { describe, expect, test } from "bun:test";
import { ReviewChunkAssembler } from "./resourceAssembly";

const GENERATION = "generation:p1:0";
const RESOURCE_ID = "resource:patch:file:abcdef";
const DIGEST = "b".repeat(64);

/** One assembler with no synchronous digest, as a browser constructs it. */
function createTestAsyncAssembler() {
  return new ReviewChunkAssembler({
    resourceId: RESOURCE_ID,
    generation: GENERATION,
    maxBytes: 1024,
  });
}

/** Feed one complete three-byte resource into an assembler. */
function feedTestResource(assembler: ReviewChunkAssembler) {
  return assembler.accept({
    chunk: {
      generation: GENERATION,
      resourceId: RESOURCE_ID,
      offset: 0,
      byteLength: 3,
      encoding: "base64",
      data: "",
      contentDigest: DIGEST,
      contentSize: 3,
      eof: true,
    },
    bytes: new Uint8Array([1, 2, 3]),
  });
}

describe("ReviewChunkAssembler.finishAsync", () => {
  test("verifies with an asynchronous digest", async () => {
    const assembler = createTestAsyncAssembler();
    expect(feedTestResource(assembler)).toEqual({ ok: true, done: true });

    const result = await assembler.finishAsync(async () => DIGEST);

    expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  test("refuses bytes that hash to another digest", async () => {
    const assembler = createTestAsyncAssembler();
    feedTestResource(assembler);

    const result = await assembler.finishAsync(async () => "c".repeat(64));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("resource-integrity");
  });

  test("refuses to finish an unfinished stream before hashing anything", async () => {
    let hashed = false;
    const result = await createTestAsyncAssembler().finishAsync(async () => {
      hashed = true;
      return DIGEST;
    });

    expect(result.ok).toBe(false);
    expect(hashed).toBe(false);
  });

  test("reports a synchronous finish without a synchronous digest as a refusal", () => {
    const assembler = createTestAsyncAssembler();
    feedTestResource(assembler);

    expect(assembler.finish().ok).toBe(false);
  });
});
