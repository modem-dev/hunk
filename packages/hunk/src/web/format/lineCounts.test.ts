import { describe, expect, test } from "bun:test";
import {
  formatAddedBadge,
  formatAddedCount,
  formatCount,
  formatFileCount,
  formatRemovedBadge,
  formatRemovedCount,
} from "./lineCounts";

describe("line count formatting", () => {
  test("groups digits with the en-US separator", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(25048)).toBe("25,048");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  test("signs additions with + and removals with a true minus", () => {
    expect(formatAddedCount(25048)).toBe("+25,048");
    expect(formatAddedCount(10, true)).toBe("+10+");
    expect(formatRemovedCount(47)).toBe("−47");
  });

  test("names file counts", () => {
    expect(formatFileCount(1)).toBe("1 file");
    expect(formatFileCount(0)).toBe("0 files");
    expect(formatFileCount(2000)).toBe("2,000 files");
  });

  test("hides zero badges", () => {
    expect(formatAddedBadge(0)).toBeNull();
    expect(formatRemovedBadge(0)).toBeNull();
    expect(formatAddedBadge(1200)).toBe("+1,200");
    expect(formatRemovedBadge(1200)).toBe("−1,200");
  });
});
