import { describe, expect, test } from "bun:test";
import { resolveResponsiveLayout } from "./responsive";

// Policy thresholds: >=220 full, >=160 medium with a sidebar; auto splits at >=200 by default.
const TIGHT_WIDTH = 100;
const NARROW_WIDTH = 140;
const MEDIUM_WIDTH = 180;
const FULL_WIDTH = 240;

describe("resolveResponsiveLayout — auto", () => {
  test("chooses unified with no sidebar on tight terminals", () => {
    expect(resolveResponsiveLayout("auto", TIGHT_WIDTH)).toEqual({
      viewport: "tight",
      layout: "unified",
      showSidebar: false,
    });
  });

  test("chooses unified with a sidebar on medium terminals below the default threshold", () => {
    expect(resolveResponsiveLayout("auto", MEDIUM_WIDTH)).toEqual({
      viewport: "medium",
      layout: "unified",
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

  test("keeps unified even on a full-width terminal and still shows the sidebar there", () => {
    expect(resolveResponsiveLayout("unified", FULL_WIDTH)).toEqual({
      viewport: "full",
      layout: "unified",
      showSidebar: true,
    });
  });

  test("shows the sidebar at medium and full widths for explicit modes", () => {
    expect(resolveResponsiveLayout("split", MEDIUM_WIDTH).showSidebar).toBe(true);
    expect(resolveResponsiveLayout("unified", MEDIUM_WIDTH).showSidebar).toBe(true);
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

  test("the sidebar cutoff does not change the auto layout", () => {
    expect(resolveResponsiveLayout("auto", 159)).toMatchObject({
      layout: "unified",
      showSidebar: false,
    });
    expect(resolveResponsiveLayout("auto", 160)).toMatchObject({
      layout: "unified",
      showSidebar: true,
    });
  });

  test("auto switches from unified to split at the default 200-column threshold", () => {
    expect(resolveResponsiveLayout("auto", 199)).toMatchObject({
      layout: "unified",
      showSidebar: true,
    });
    expect(resolveResponsiveLayout("auto", 200)).toMatchObject({
      layout: "split",
      showSidebar: true,
    });
  });
});

describe("resolveResponsiveLayout — configured auto threshold", () => {
  test("a lower threshold keeps split after the sidebar disappears", () => {
    expect(resolveResponsiveLayout("auto", 119, 120).layout).toBe("unified");
    expect(resolveResponsiveLayout("auto", 120, 120).layout).toBe("split");
    expect(resolveResponsiveLayout("auto", NARROW_WIDTH, 120)).toEqual({
      viewport: "tight",
      layout: "split",
      showSidebar: false,
    });
  });

  test("a higher threshold keeps full-width terminals unified", () => {
    expect(resolveResponsiveLayout("auto", FULL_WIDTH, 300)).toEqual({
      viewport: "full",
      layout: "unified",
      showSidebar: true,
    });
  });

  test("explicit modes ignore the threshold", () => {
    expect(resolveResponsiveLayout("split", TIGHT_WIDTH, 300).layout).toBe("split");
    expect(resolveResponsiveLayout("unified", FULL_WIDTH, 120).layout).toBe("unified");
  });
});
