import { describe, expect, test } from "bun:test";
import {
  BROWSER_SPLIT_LAYOUT_MIN_WIDTH,
  DEFAULT_BROWSER_VIEW_OPTIONS,
  resolveBrowserDiffStyle,
  resolveBrowserViewOptions,
} from "./viewOptions";

describe("resolveBrowserViewOptions", () => {
  test("starts from the built-in defaults when the host supplied none", () => {
    expect(resolveBrowserViewOptions()).toEqual(DEFAULT_BROWSER_VIEW_OPTIONS);
  });

  test("adopts the host's resolved defaults for the options that are this client's", () => {
    expect(
      resolveBrowserViewOptions({ mode: "stack", wrapLines: true, showLineNumbers: false }),
    ).toEqual({
      layout: "stack",
      wrapLines: true,
      showLineNumbers: false,
      showHunkHeaders: true,
    });
  });

  test("lets this client override what the host suggested", () => {
    expect(resolveBrowserViewOptions({ mode: "stack" }, { layout: "split" }).layout).toBe("split");
  });

  test("keeps review-wide options out of the client's view options entirely", () => {
    // G1: `showAgentNotes` and the filter are the review's, and a per-client copy of one
    // is how two surfaces come to show different reviews.
    const resolved = resolveBrowserViewOptions({ showAgentNotes: true, filter: "src/" });

    expect(Object.keys(resolved).sort()).toEqual([
      "layout",
      "showHunkHeaders",
      "showLineNumbers",
      "wrapLines",
    ]);
  });
});

describe("resolveBrowserDiffStyle", () => {
  test("chooses by width only when the layout is auto", () => {
    expect(resolveBrowserDiffStyle("auto", BROWSER_SPLIT_LAYOUT_MIN_WIDTH)).toBe("split");
    expect(resolveBrowserDiffStyle("auto", BROWSER_SPLIT_LAYOUT_MIN_WIDTH - 1)).toBe("unified");
  });

  test("an explicit choice overrides the responsive one", () => {
    expect(resolveBrowserDiffStyle("split", 320)).toBe("split");
    expect(resolveBrowserDiffStyle("stack", 4_000)).toBe("unified");
  });
});
