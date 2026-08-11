import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from ".";
import { paneKey } from "../../apply";

describe("bundled UI registry", () => {
  test("registers files first and the fixed current-line lens second", () => {
    const panes = getBundledUIRegistry().panes;
    expect(panes.map(paneKey)).toEqual(["hunk:files", "hunk:line-lens"]);
    expect(panes[1]?.pane).toMatchObject({
      placement: "bottom",
      defaultOpen: false,
      currentLine: true,
      thickness: { preferred: 3, min: 3, max: 3 },
    });
  });
});
