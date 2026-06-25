import { describe, expect, test } from "bun:test";
import { getLanguageForFileName } from "./fileLanguage";

describe("getLanguageForFileName", () => {
  test("maps TypeScript module/commonjs extensions to typescript", () => {
    expect(getLanguageForFileName("foo.mts")).toBe("typescript");
    expect(getLanguageForFileName("foo.cts")).toBe("typescript");
    expect(getLanguageForFileName("src/nested/foo.mts")).toBe("typescript");
  });

  test("preserves Pierre's built-in extension detection", () => {
    expect(getLanguageForFileName("foo.ts")).toBe("typescript");
    expect(getLanguageForFileName("foo.tsx")).toBe("tsx");
    expect(getLanguageForFileName("foo.mjs")).toBe("javascript");
    expect(getLanguageForFileName("foo.cjs")).toBe("javascript");
  });
});
