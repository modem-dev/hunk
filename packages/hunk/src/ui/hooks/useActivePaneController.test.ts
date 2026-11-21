import { describe, expect, test } from "bun:test";
import type { Renderable } from "@opentui/core";
import { paneKeyFromFocusedRenderable } from "./useActivePaneController";

/** Build the minimal renderable ancestry needed to test host surface ownership. */
function renderable(id: string, parent: Renderable | null = null): Renderable {
  return { id, parent } as Renderable;
}

describe("active pane focus ownership", () => {
  test("finds pane and review roots through focused descendants", () => {
    const pane = renderable("pane");
    const editor = renderable("prompt", renderable("card", pane));
    const review = renderable("review");
    const noteEditor = renderable("draft", review);
    const roots = new Map<Renderable, string | null>([
      [pane, "fixture:agent"],
      [review, null],
    ]);

    expect(paneKeyFromFocusedRenderable(editor, roots)).toBe("fixture:agent");
    expect(paneKeyFromFocusedRenderable(noteEditor, roots)).toBeNull();
  });

  test("ignores focus outside the review workspace", () => {
    const roots = new Map<Renderable, string | null>();
    expect(paneKeyFromFocusedRenderable(renderable("menu"), roots)).toBeUndefined();
    expect(paneKeyFromFocusedRenderable(null, roots)).toBeUndefined();
  });
});
