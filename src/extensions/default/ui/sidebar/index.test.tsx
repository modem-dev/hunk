import { describe, expect, test } from "bun:test";
import { sidebarViewKey } from "../../../apply";
import {
  BUNDLED_SIDEBAR_EXTENSION_ID,
  BUNDLED_SIDEBAR_VIEW_ID,
  BuiltInSidebarView,
  getBundledSidebarView,
} from ".";

describe("bundled sidebar extension", () => {
  test("registers the built-in view through the public factory path", () => {
    const registered = getBundledSidebarView();

    expect(registered.extensionId).toBe(BUNDLED_SIDEBAR_EXTENSION_ID);
    expect(registered.view.id).toBe(BUNDLED_SIDEBAR_VIEW_ID);
    // The registration carries the exact component the app renders and the
    // extension pipeline falls back to, so there is one built-in sidebar.
    expect(registered.view.component).toBe(BuiltInSidebarView);
  });

  test("owns the reserved vendor id, so no extension can mint its view key", () => {
    // `hunk` is refused as an extension id at load, which is what makes this
    // key unreachable from disk — a `sidebar.ts` extension used to collide.
    expect(BUNDLED_SIDEBAR_EXTENSION_ID).toBe("hunk");
    expect(sidebarViewKey(getBundledSidebarView())).toBe("hunk:files");
  });

  test("loads once and hands back the same registration afterwards", () => {
    expect(getBundledSidebarView()).toBe(getBundledSidebarView());
  });
});
