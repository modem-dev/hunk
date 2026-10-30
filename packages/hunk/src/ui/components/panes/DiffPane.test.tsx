import { describe, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { resetOpenTuiScrollAccumulators } from "./DiffPane";

describe("resetOpenTuiScrollAccumulators", () => {
  test("requires the OpenTUI 0.5.6 compatibility operation", () => {
    const resetScrollAccumulators = (
      ScrollBoxRenderable.prototype as unknown as { resetScrollAccumulators?: () => void }
    ).resetScrollAccumulators;

    expect(resetScrollAccumulators).toBeFunction();
  });

  test("fails clearly when an OpenTUI upgrade removes the compatibility operation", () => {
    expect(() => resetOpenTuiScrollAccumulators({} as unknown as ScrollBoxRenderable)).toThrow(
      "OpenTUI 0.5.6 ScrollBoxRenderable.resetScrollAccumulators is required after shifted wheel input.",
    );
  });
});
