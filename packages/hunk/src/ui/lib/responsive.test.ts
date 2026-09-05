import { describe, expect, test } from "bun:test";
import { resolveResponsiveLayout } from "./responsive";

// Policy thresholds: >=220 full, >=160 medium with a sidebar, >=120 split without one.
const TIGHT_WIDTH = 100;
const NARROW_SPLIT_WIDTH = 140;
const MEDIUM_WIDTH = 180;
const FULL_WIDTH = 240;

describe("resolveResponsiveLayout — auto", () => {
  test("chooses stack with no sidebar on tight terminals", () => {
    expect(resolveResponsiveLayout("auto", TIGHT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "stack",
      showSidebar: false,
    });
  });

  test("keeps split after the sidebar disappears on narrow terminals", () => {
    expect(resolveResponsiveLayout("auto", NARROW_SPLIT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "split",
      showSidebar: false,
    });
  });

  test("chooses split with a compact-capable sidebar on medium terminals", () => {
    expect(resolveResponsiveLayout("auto", MEDIUM_WIDTH)).toEqual({
      viewport: "medium",
      layout: "split",
      showSidebar: true,
    });
  });

  test("chooses split with a sidebar on full-width terminals", () => {
    expect(resolveResponsiveLayout("auto", FULL_WIDTH)).toEqual({
      viewport: "full",
      layout: "split",
      showSidebar: true,
    });
  });
});

describe("resolveResponsiveLayout — explicit overrides", () => {
  test("keeps split even on a tight terminal while hiding the sidebar", () => {
    expect(resolveResponsiveLayout("split", TIGHT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "split",
      showSidebar: false,
    });
  });

  test("keeps stack even on a full-width terminal and still shows the sidebar there", () => {
    expect(resolveResponsiveLayout("stack", FULL_WIDTH)).toEqual({
      viewport: "full",
      layout: "stack",
      showSidebar: true,
    });
  });

  test("shows the sidebar at medium and full widths for explicit modes", () => {
    expect(resolveResponsiveLayout("split", MEDIUM_WIDTH).showSidebar).toBe(true);
    expect(resolveResponsiveLayout("stack", MEDIUM_WIDTH).showSidebar).toBe(true);
    expect(resolveResponsiveLayout("split", FULL_WIDTH).showSidebar).toBe(true);
  });
});

describe("resolveResponsiveLayout — viewport bucket boundaries", () => {
  test("classifies exactly at the medium and full minimum widths", () => {
    // Sidebar visibility remains bucketed at 160; full chrome starts at 220.
    expect(resolveResponsiveLayout("auto", 159).viewport).toBe("tight");
    expect(resolveResponsiveLayout("auto", 160).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 219).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 220).viewport).toBe("full");
  });

  test("the sidebar cutoff no longer changes the split layout", () => {
    expect(resolveResponsiveLayout("auto", 159)).toMatchObject({
      layout: "split",
      showSidebar: false,
    });
    expect(resolveResponsiveLayout("auto", 160)).toMatchObject({
      layout: "split",
      showSidebar: true,
    });
  });

  test("auto switches from stack to split at its narrower independent cutoff", () => {
    expect(resolveResponsiveLayout("auto", 119)).toMatchObject({
      layout: "stack",
      showSidebar: false,
    });
    expect(resolveResponsiveLayout("auto", 120)).toMatchObject({
      layout: "split",
      showSidebar: false,
    });
  });
});
