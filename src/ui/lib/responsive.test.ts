import { describe, expect, test } from "bun:test";
import { resolveResponsiveLayout } from "./responsive";

// Width thresholds the module buckets against: >=220 full, >=160 medium, else tight.
const TIGHT_WIDTH = 120;
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

  test("chooses split without a sidebar on medium terminals", () => {
    expect(resolveResponsiveLayout("auto", MEDIUM_WIDTH)).toEqual({
      viewport: "medium",
      layout: "split",
      showSidebar: false,
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
  test("keeps split even on a tight terminal but hides the sidebar", () => {
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

  test("shows the sidebar only at full width for explicit modes", () => {
    expect(resolveResponsiveLayout("split", MEDIUM_WIDTH).showSidebar).toBe(false);
    expect(resolveResponsiveLayout("stack", MEDIUM_WIDTH).showSidebar).toBe(false);
    expect(resolveResponsiveLayout("split", FULL_WIDTH).showSidebar).toBe(true);
  });
});

describe("resolveResponsiveLayout — viewport bucket boundaries", () => {
  test("classifies exactly at the medium and full minimum widths", () => {
    // 159 is still tight; 160 is the first medium width; 220 is the first full width.
    expect(resolveResponsiveLayout("auto", 159).viewport).toBe("tight");
    expect(resolveResponsiveLayout("auto", 160).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 219).viewport).toBe("medium");
    expect(resolveResponsiveLayout("auto", 220).viewport).toBe("full");
  });

  test("the tight-to-medium boundary flips auto from stack to split", () => {
    expect(resolveResponsiveLayout("auto", 159).layout).toBe("stack");
    expect(resolveResponsiveLayout("auto", 160).layout).toBe("split");
  });
});
