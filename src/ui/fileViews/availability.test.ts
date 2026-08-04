import { describe, expect, test } from "bun:test";
import {
  availableFileViewSelections,
  FILE_VIEW_DRAFT_UNAVAILABLE_REASON,
  fileViewUnavailableReason,
  presentedFileViewKey,
} from "./availability";

describe("file-view availability", () => {
  test("leaves committed note placement to validated alternate-view bindings", () => {
    // A file carrying agent or user notes no longer forces raw: placement is decided by the
    // validated source bindings in the render plan, so drafting is the only host constraint left.
    expect(fileViewUnavailableReason({ hasDraftNote: false })).toBeNull();
  });

  test("requires raw diff while a draft note is being edited", () => {
    expect(fileViewUnavailableReason({ hasDraftNote: true })).toBe(
      FILE_VIEW_DRAFT_UNAVAILABLE_REASON,
    );
  });

  test("preserves selection identity when no host constraint masks a view", () => {
    const selections = { readme: "preview:rendered" };
    expect(availableFileViewSelections(selections, new Map())).toBe(selections);
    expect(
      availableFileViewSelections(
        selections,
        new Map([["other", FILE_VIEW_DRAFT_UNAVAILABLE_REASON]]),
      ),
    ).toBe(selections);
  });

  test("masks unavailable selections without discarding stored choices", () => {
    const selections = { readme: "preview:rendered", other: "ext:view" };
    expect(
      availableFileViewSelections(
        selections,
        new Map([["readme", FILE_VIEW_DRAFT_UNAVAILABLE_REASON]]),
      ),
    ).toEqual({ other: "ext:view" });
    expect(selections).toEqual({ readme: "preview:rendered", other: "ext:view" });
  });

  test("reports the presentation one file actually shows, not just its stored choice", () => {
    const selections = { readme: "preview:rendered" };
    expect(presentedFileViewKey(selections, new Map(), "readme")).toBe("preview:rendered");
    expect(presentedFileViewKey(selections, new Map(), "other")).toBeNull();
    expect(presentedFileViewKey(selections, new Map(), null)).toBeNull();
    // A host constraint (an open draft note) keeps the file raw despite the choice.
    expect(
      presentedFileViewKey(
        selections,
        new Map([["readme", FILE_VIEW_DRAFT_UNAVAILABLE_REASON]]),
        "readme",
      ),
    ).toBeNull();
  });
});
