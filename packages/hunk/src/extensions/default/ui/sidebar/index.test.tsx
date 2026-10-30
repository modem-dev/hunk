import { describe, expect, test } from "bun:test";
import { paneKey } from "../../../apply";
import { BUNDLED_SIDEBAR_EXTENSION_ID, BUNDLED_SIDEBAR_VIEW_ID, FlexFileSidebar } from ".";
import { getBundledUIRegistry } from "..";

const getBundledFilesPane = () => getBundledUIRegistry().panes[0]!;

describe("bundled sidebar extension", () => {
  test("registers the built-in view through the public factory path", () => {
    const registered = getBundledFilesPane();

    expect(registered.extensionId).toBe(BUNDLED_SIDEBAR_EXTENSION_ID);
    expect(registered.pane.id).toBe(BUNDLED_SIDEBAR_VIEW_ID);
    // The registration carries the exact component the app renders and the
    // extension pipeline falls back to, so there is one built-in sidebar.
    expect(registered.pane.component).toBe(FlexFileSidebar);
    expect(registered.pane.width).toEqual({
      preferred: 34,
      min: 22,
      max: 56,
      fraction: 0.16,
    });
  });

  test("owns the reserved vendor id, so no extension can mint its view key", () => {
    // `hunk` is refused as an extension id at load, which is what makes this
    // key unreachable from disk — a `sidebar.ts` extension used to collide.
    expect(BUNDLED_SIDEBAR_EXTENSION_ID).toBe("hunk");
    expect(paneKey(getBundledFilesPane())).toBe("hunk:files");
  });

  test("loads once and hands back the same registration afterwards", () => {
    expect(getBundledFilesPane()).toBe(getBundledFilesPane());
  });
});
