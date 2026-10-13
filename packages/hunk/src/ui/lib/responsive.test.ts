import { describe, expect, test } from "bun:test";
import { resolveResponsiveLayout, resolveResponsiveViewport } from "./responsive";

describe("resolveResponsiveLayout", () => {
  test("switches at exactly 160 available diff columns by default", () => {
    expect(resolveResponsiveLayout("auto", 159)).toBe("unified");
    expect(resolveResponsiveLayout("auto", 160)).toBe("split");
    expect(resolveResponsiveLayout("auto", 240)).toBe("split");
    expect(resolveResponsiveLayout("auto", 0)).toBe("unified");
  });

  test("configured minimum widths move the inclusive cutoff", () => {
    expect(resolveResponsiveLayout("auto", 119, 120)).toBe("unified");
    expect(resolveResponsiveLayout("auto", 120, 120)).toBe("split");
    expect(resolveResponsiveLayout("auto", 299, 300)).toBe("unified");
    expect(resolveResponsiveLayout("auto", 300, 300)).toBe("split");
  });

  test("explicit modes ignore available width and the configured cutoff", () => {
    expect(resolveResponsiveLayout("split", 0, 300)).toBe("split");
    expect(resolveResponsiveLayout("unified", 240, 120)).toBe("unified");
  });
});

describe("resolveResponsiveViewport", () => {
  test("keeps terminal viewport buckets independent of available diff width", () => {
    expect(resolveResponsiveViewport(159)).toBe("tight");
    expect(resolveResponsiveViewport(160)).toBe("medium");
    expect(resolveResponsiveViewport(219)).toBe("medium");
    expect(resolveResponsiveViewport(220)).toBe("full");
    expect(resolveResponsiveLayout("auto", 120)).toBe("unified");
  });
});
