import { describe, expect, test } from "bun:test";
import { FilterEditSequence } from "./filterEdits";

describe("FilterEditSequence", () => {
  test("ends editing when the latest edit's reply arrives", () => {
    const edits = new FilterEditSequence();
    expect(edits.editing).toBe(false);
    const sequence = edits.edit();
    expect(edits.editing).toBe(true);
    edits.settle(sequence);
    expect(edits.editing).toBe(false);
  });

  // Intent: a reply to an older filter request must not end the editing of a newer one, or
  // the older filter's snapshot overwrites what the reader is typing.
  test("keeps editing when an older request's reply arrives after a newer edit", () => {
    const edits = new FilterEditSequence();
    const older = edits.edit();
    const newer = edits.edit();

    edits.settle(older);
    expect(edits.editing).toBe(true);
    edits.settle(newer);
    expect(edits.editing).toBe(false);
  });
});
