import { describe, expect, test } from "bun:test";
import { computeRapidScrollOverscanRows } from "./adaptiveScrollOverscan";

describe("computeRapidScrollOverscanRows", () => {
  test("leaves slow row-by-row movement on the default window", () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 1, viewportHeight: 30 })).toBe(0);
    expect(computeRapidScrollOverscanRows({ deltaRows: -3, viewportHeight: 30 })).toBe(0);
  });

  test("treats the minimum burst threshold as inclusive", () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 4, viewportHeight: 30 })).toBe(90);
  });

  test("expands to at least three viewports during bursty scrolling", () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 8, viewportHeight: 30 })).toBe(90);
  });

  test("scales with large coalesced jumps but stays bounded", () => {
    expect(computeRapidScrollOverscanRows({ deltaRows: 80, viewportHeight: 20 })).toBe(160);
    expect(computeRapidScrollOverscanRows({ deltaRows: -1_000, viewportHeight: 40 })).toBe(240);
  });
});
