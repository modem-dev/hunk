import { describe, expect, test } from "bun:test";
import { formatReviewAddress } from "../../core/review/address";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import {
  fragmentWithAddress,
  readFragmentAddress,
  resolveReviewAddress,
  reviewAddressHiddenMessage,
  reviewAddressHiddenReason,
  reviewLinePlacement,
  selectionAddress,
} from "./deepLink";

describe("fragment addresses", () => {
  test("reads and writes the address beside other fragment parameters", () => {
    const address = { kind: "hunk", fileKey: "a/b%c", hunkIndex: 2 } as const;
    const hash = fragmentWithAddress("#theme=x", address);
    expect(new URLSearchParams(hash.slice(1)).get("theme")).toBe("x");
    expect(readFragmentAddress(hash)).toEqual(address);
    expect(fragmentWithAddress(hash, undefined)).toBe("#theme=x");
    expect(fragmentWithAddress("", undefined)).toBe("");
  });

  test("refuses a fragment whose address is not exactly the grammar", () => {
    expect(readFragmentAddress("#at=file/abc/hunk/-1")).toBeUndefined();
    expect(readFragmentAddress("#at=file/%25zz")).toBeUndefined();
    expect(readFragmentAddress("#capability=x")).toBeUndefined();
  });
});

describe("selectionAddress", () => {
  test("names the active note, else the selected hunk", () => {
    const state = createTestReviewState(["alpha"]);
    expect(selectionAddress(state)).toEqual({ kind: "hunk", fileKey: "alpha", hunkIndex: 0 });
    expect(selectionAddress({ ...state, activeNoteId: "n1" })).toEqual({
      kind: "note",
      fileKey: "alpha",
      noteId: "n1",
    });
  });
});

describe("resolveReviewAddress", () => {
  const state = {
    ...createTestReviewState(["alpha", "beta"]),
    liveNotes: [createTestStoredNote({ id: "n1", fileKey: "beta", hunkIndex: 1, line: 12 })],
  };

  test("resolves each address kind to the hunk that shows it", () => {
    expect(resolveReviewAddress(state, { kind: "file", fileKey: "beta" })).toEqual({
      fileKey: "beta",
      hunkIndex: 0,
    });
    expect(resolveReviewAddress(state, { kind: "hunk", fileKey: "beta", hunkIndex: 1 })).toEqual({
      fileKey: "beta",
      hunkIndex: 1,
    });
    expect(
      resolveReviewAddress(state, { kind: "line", fileKey: "beta", side: "new", line: 12 }),
    ).toEqual({ fileKey: "beta", hunkIndex: 1, side: "new", line: 12 });
    expect(resolveReviewAddress(state, { kind: "note", fileKey: "beta", noteId: "n1" })).toEqual({
      fileKey: "beta",
      hunkIndex: 1,
      noteId: "n1",
    });
  });

  test("refuses what the shown review cannot honor", () => {
    expect(resolveReviewAddress(state, { kind: "file", fileKey: "gamma" })).toBeUndefined();
    expect(
      resolveReviewAddress(state, { kind: "hunk", fileKey: "beta", hunkIndex: 9 }),
    ).toBeUndefined();
    expect(
      resolveReviewAddress(state, { kind: "note", fileKey: "alpha", noteId: "n1" }),
    ).toBeUndefined();
    expect(
      resolveReviewAddress(state, { kind: "note", fileKey: "beta", noteId: "missing" }),
    ).toBeUndefined();
  });

  test("round-trips through the fragment for keys with separators and non-ASCII", () => {
    const address = { kind: "note", fileKey: "src/ü #1", noteId: "user:1/2" } as const;
    const hash = fragmentWithAddress("", address);
    expect(hash).toBe(`#at=${encodeURIComponent(formatReviewAddress(address))}`);
    expect(readFragmentAddress(hash)).toEqual(address);
  });
});

describe("reviewAddressHiddenReason", () => {
  const state = {
    ...createTestReviewState(["alpha", "beta"], { showAgentNotes: true }),
    liveNotes: [createTestStoredNote({ id: "n1", fileKey: "beta", hunkIndex: 1, line: 12 })],
  };
  const NONE = new Set<string>();

  // Intent: a link to something the review has but this page does not show is named with its
  // reason rather than silently landing elsewhere.
  test("names the filter, hide viewed, and hidden agent notes as reasons", () => {
    const beta = { kind: "file", fileKey: "beta" } as const;
    expect(reviewAddressHiddenReason(state, beta, NONE)).toBeUndefined();
    expect(reviewAddressHiddenReason({ ...state, filter: "alpha" }, beta, NONE)).toBe("filter");
    expect(reviewAddressHiddenReason(state, beta, new Set(["beta"]))).toBe("hidden-viewed");

    const note = { kind: "note", fileKey: "beta", noteId: "n1" } as const;
    expect(reviewAddressHiddenReason(state, note, NONE)).toBeUndefined();
    expect(reviewAddressHiddenReason({ ...state, showAgentNotes: false }, note, NONE)).toBe(
      "agent-notes-hidden",
    );
  });

  test("words each reason with the file's path", () => {
    expect(reviewAddressHiddenMessage("filter", "src/a.ts")).toContain("shared filter");
    expect(reviewAddressHiddenMessage("hidden-viewed", "src/a.ts")).toContain("Hide viewed");
    expect(reviewAddressHiddenMessage("agent-notes-hidden", "src/a.ts")).toContain(
      "agent notes are hidden",
    );
  });
});

describe("reviewLinePlacement", () => {
  const file = createTestReviewState(["alpha"]).document.files[0]!;

  // Intent: a linked line inside a collapsed gap can be shown by expanding the gap; one no
  // hunk or gap covers is reported instead of quietly landing on a hunk's top.
  test("places a line as drawn, inside a gap, or absent", () => {
    expect(reviewLinePlacement(file, "new", 2)).toEqual({ kind: "drawn" });
    expect(reviewLinePlacement(file, "new", 7)).toEqual({ kind: "gap", gapId: "before:1" });
    expect(reviewLinePlacement(file, "new", 500)).toEqual({ kind: "absent" });
  });
});
