import { describe, expect, test } from "bun:test";
import { REVIEW_PATCH_CONTENT_TYPE, reviewResourceId } from "../../core/review/resources";
import type { HunkReviewResourceCatalogV1 } from "../reviewProtocol";
import {
  ReviewMirror,
  readRegistrationReviewCatalog,
  readSnapshotReviewPublication,
} from "./reviewMirror";

const FILE_KEY = "file:0123456789abcdef";

function catalog(generation: string): HunkReviewResourceCatalogV1 {
  return {
    generation,
    fileKeysByRuntimeId: { "file-1": FILE_KEY },
    resources: [
      {
        id: reviewResourceId({ kind: "patch", fileKey: FILE_KEY }),
        generation,
        fileKey: FILE_KEY,
        kind: "patch",
        contentType: REVIEW_PATCH_CONTENT_TYPE,
      },
    ],
  };
}

function address(generation: string, stateRevision: number) {
  return { generation, stateRevision };
}

describe("ReviewMirror", () => {
  // Intent: a session's first publication is adopted whole — position and catalog together.
  test("adopts a session's first publication", () => {
    const mirror = new ReviewMirror();
    const update = mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 0),
    });

    expect(update).toEqual({ kind: "adopted", generation: "generation:p1:0" });
    expect(mirror.get("s-1")?.address.stateRevision).toBe(0);
  });

  // Intent: C1 — revisions may skip, and the mirror follows the shared classifier rather
  // than demanding contiguity.
  test("advances on a further revision, contiguous or not", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 1),
    });

    expect(
      mirror.observe({
        sessionId: "s-1",
        catalog: undefined,
        address: address("generation:p1:0", 41),
      }),
    ).toEqual({ kind: "advanced", generation: "generation:p1:0", stateRevision: 41 });
    expect(mirror.get("s-1")?.address.stateRevision).toBe(41);
  });

  test("ignores a replayed or earlier revision", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 5),
    });

    for (const revision of [5, 4, 0]) {
      expect(
        mirror.observe({
          sessionId: "s-1",
          catalog: undefined,
          address: address("generation:p1:0", revision),
        }),
      ).toEqual({ kind: "ignored" });
    }
    expect(mirror.get("s-1")?.address.stateRevision).toBe(5);
  });

  // Intent: a generation swap retires everything derived from the old one, and the caller
  // is told which generation that was so it can drop it.
  test("replaces the publication when the generation advances", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 9),
    });

    expect(
      mirror.observe({
        sessionId: "s-1",
        catalog: catalog("generation:p1:1"),
        address: address("generation:p1:1", 0),
      }),
    ).toEqual({
      kind: "replaced",
      generation: "generation:p1:1",
      previousGeneration: "generation:p1:0",
    });
    expect(mirror.get("s-1")?.catalog.generation).toBe("generation:p1:1");
  });

  // Intent: advertising resources for a generation whose catalog has not arrived would
  // promise reads that cannot be served.
  test("waits for the catalog before adopting a new generation", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 2),
    });

    expect(
      mirror.observe({
        sessionId: "s-1",
        catalog: catalog("generation:p1:0"),
        address: address("generation:p1:1", 0),
      }),
    ).toEqual({ kind: "ignored" });
    expect(mirror.get("s-1")?.address.generation).toBe("generation:p1:0");
  });

  test("ignores a publication from an unrelated producer", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 2),
    });

    expect(
      mirror.observe({
        sessionId: "s-1",
        catalog: catalog("generation:p2:9"),
        address: address("generation:p2:9", 900),
      }),
    ).toEqual({ kind: "ignored" });
  });

  // Intent: a session built before the mirror existed is mirrored as nothing, not refused.
  test("mirrors nothing for a session that publishes nothing", () => {
    const mirror = new ReviewMirror();

    expect(mirror.observe({ sessionId: "s-1", catalog: undefined, address: undefined })).toEqual({
      kind: "ignored",
    });
    expect(mirror.get("s-1")).toBeUndefined();
    expect(mirror.sessionIds()).toEqual([]);
  });

  test("forgets one session and clears them all", () => {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "s-1",
      catalog: catalog("generation:p1:0"),
      address: address("generation:p1:0", 0),
    });
    mirror.observe({
      sessionId: "s-2",
      catalog: catalog("generation:p2:0"),
      address: address("generation:p2:0", 0),
    });

    mirror.forget("s-1");
    expect(mirror.sessionIds()).toEqual(["s-2"]);
    mirror.clear();
    expect(mirror.sessionIds()).toEqual([]);
  });
});

describe("mirror payload readers", () => {
  test("read the catalog and address the shared parsers accept", () => {
    expect(
      readRegistrationReviewCatalog({ info: { reviewCatalog: catalog("generation:p1:0") } }),
    ).toEqual(catalog("generation:p1:0"));
    expect(
      readSnapshotReviewPublication({
        state: { reviewPublication: address("generation:p1:0", 3) },
      }),
    ).toEqual(address("generation:p1:0", 3));
  });

  test("read nothing from a payload that carries nothing", () => {
    expect(readRegistrationReviewCatalog({ info: {} })).toBeUndefined();
    expect(readRegistrationReviewCatalog(null)).toBeUndefined();
    expect(readSnapshotReviewPublication({ state: {} })).toBeUndefined();
    expect(readSnapshotReviewPublication(undefined)).toBeUndefined();
  });

  test("read nothing from a malformed catalog or address", () => {
    expect(
      readRegistrationReviewCatalog({ info: { reviewCatalog: { generation: 1 } } }),
    ).toBeUndefined();
    expect(
      readSnapshotReviewPublication({ state: { reviewPublication: { generation: "x" } } }),
    ).toBeUndefined();
  });
});
