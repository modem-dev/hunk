import { describe, expect, test } from "bun:test";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { getBundledFileLanguages } from ".";

describe("bundled file languages", () => {
  test("exposes Starlark selectors under the vendor extension id", () => {
    const languages = getBundledFileLanguages();
    expect(languages.length).toBeGreaterThan(0);
    expect(languages.every((entry) => entry.extensionId === HUNK_VENDOR_EXTENSION_ID)).toBe(true);
  });
});
