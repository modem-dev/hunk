import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ReviewSnapshotMirror, ReviewSseChunks, type ReviewMirrorEvent } from "./mirror";
import type { BrowserReviewSnapshot } from "./reviewTypes";

function snapshot(generation = "generation:a", revision = 1): BrowserReviewSnapshot {
  return {
    generation,
    manifest: {
      version: 1,
      generation,
      documentIdentity: "document:test",
      changesetId: "changeset:test",
      title: "Review",
      sourceLabel: "test",
      files: [],
      resources: [],
      capabilities: { actions: [] },
    },
    state: {
      documentGeneration: generation,
      stateRevision: revision,
      selection: { fileKey: null, hunkIndex: 0 },
      filter: "",
      showAgentNotes: true,
      notes: [],
    },
  };
}

describe("ReviewSnapshotMirror", () => {
  test("ignores stale revisions, reports gaps, and retires replaced generations", () => {
    const mirror = new ReviewSnapshotMirror();
    expect(mirror.apply({ type: "snapshot", data: snapshot("generation:a", 2) }).kind).toBe(
      "accepted",
    );
    expect(
      mirror.apply({
        type: "state",
        data: { generation: "generation:a", state: snapshot("generation:a", 1).state },
      }).kind,
    ).toBe("stale");
    expect(
      mirror.apply({
        type: "state",
        data: { generation: "generation:a", state: snapshot("generation:a", 4).state },
      }).kind,
    ).toBe("gap");
    expect(mirror.apply({ type: "document", data: snapshot("generation:b", 0) }).kind).toBe(
      "accepted",
    );
    expect(mirror.apply({ type: "document", data: snapshot("generation:a", 5) }).kind).toBe(
      "stale",
    );
    expect(mirror.getSnapshot()?.generation).toBe("generation:b");
    expect(
      mirror.apply({
        type: "state",
        data: { generation: "generation:unknown", state: snapshot("generation:unknown", 1).state },
      }).kind,
    ).toBe("gap");
  });

  test("reconstructs a complete digest-checked chunk batch before emitting", async () => {
    const payload = snapshot("generation:chunked", 3);
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const chunks = [bytes.slice(0, 37), bytes.slice(37)];
    const digest = createHash("sha256").update(bytes).digest("hex");
    const emitted: ReviewMirrorEvent[] = [];
    const assembler = new ReviewSseChunks((event) => {
      emitted.push(event);
    });
    await assembler.accept("snapshot-begin", {
      id: "batch",
      encoding: "base64",
      byteLength: bytes.byteLength,
      chunkCount: chunks.length,
      digest,
    });
    for (const [index, chunk] of chunks.entries()) {
      await assembler.accept("snapshot-chunk", {
        id: "batch",
        index,
        data: Buffer.from(chunk).toString("base64"),
      });
    }
    expect(emitted).toHaveLength(0);
    await assembler.accept("snapshot-end", {
      id: "batch",
      byteLength: bytes.byteLength,
      chunkCount: chunks.length,
      digest,
    });
    expect(emitted).toEqual([{ type: "snapshot", data: payload }]);
  });

  test("requests full recovery for malformed and digest-mismatched batches", async () => {
    let recoveries = 0;
    const assembler = new ReviewSseChunks(
      () => {},
      () => {
        recoveries += 1;
      },
    );
    await assembler.accept("snapshot-begin", {
      id: "bad",
      encoding: "base64",
      byteLength: 2,
      chunkCount: 1,
      digest: "0".repeat(64),
    });
    await assembler.accept("snapshot-chunk", { id: "bad", index: 0, data: "e30=" });
    await assembler.accept("snapshot-end", {
      id: "bad",
      byteLength: 2,
      chunkCount: 1,
      digest: "0".repeat(64),
    });
    await assembler.accept("state-chunk", { id: "missing", index: 0, data: "e30=" });
    expect(recoveries).toBe(2);
  });
});
