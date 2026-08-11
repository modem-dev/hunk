import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from ".";
import { paneKey } from "../../apply";

describe("bundled UI registry", () => {
  test("registers only the built-in files pane", () => {
    const panes = getBundledUIRegistry().panes;
    expect(panes.map(paneKey)).toEqual(["hunk:files"]);
  });
});
