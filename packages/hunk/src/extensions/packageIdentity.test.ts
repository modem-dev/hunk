import { describe, expect, test } from "bun:test";
import {
  normalizeExtensionPackageId,
  normalizeFallbackExtensionPackageId,
  sanitizeExtensionPackageDisplay,
} from "./packageIdentity";

describe("extension package identity", () => {
  test("accepts bounded package ids including npm scopes", () => {
    expect(normalizeExtensionPackageId("hunk-git")).toBe("hunk-git");
    expect(normalizeExtensionPackageId("@acme/review-tools")).toBe("@acme/review-tools");
    expect(normalizeExtensionPackageId(" Upper ")).toBeUndefined();
    expect(normalizeExtensionPackageId("bad/id/extra")).toBeUndefined();
    expect(normalizeExtensionPackageId("a".repeat(129))).toBeUndefined();
  });

  test("canonicalizes legacy folder names into manageable package ids", () => {
    expect(normalizeFallbackExtensionPackageId("Upper_Name")).toBe("upper_name");
    expect(normalizeFallbackExtensionPackageId("  invalid folder!? ")).toBe("invalid-folder-");
    expect(normalizeFallbackExtensionPackageId("💥")).toBe("extension");
  });

  test("removes terminal controls and bounds display metadata", () => {
    expect(sanitizeExtensionPackageDisplay("safe\u001b[31m\nname")).toBe("safe[31mname");
    expect(sanitizeExtensionPackageDisplay("x".repeat(200))).toHaveLength(160);
  });
});
