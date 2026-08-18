import { describe, expect, test } from "bun:test";
import { BUILT_IN_FILE_LANGUAGE_EXTENSIONS, registerFileLanguage } from "./fileLanguage";
import { fileLanguageForPath } from "./fileLanguageLookup";

describe("custom file language registration", () => {
  test("maps TypeScript module/commonjs extensions to typescript", () => {
    expect(fileLanguageForPath("foo.mts")).toBe("typescript");
    expect(fileLanguageForPath("foo.cts")).toBe("typescript");
    expect(fileLanguageForPath("src/nested/foo.mts")).toBe("typescript");
  });

  test("preserves Pierre's built-in extension detection", () => {
    expect(fileLanguageForPath("foo.ts")).toBe("typescript");
    expect(fileLanguageForPath("foo.tsx")).toBe("tsx");
    expect(fileLanguageForPath("foo.mjs")).toBe("javascript");
    expect(fileLanguageForPath("foo.cjs")).toBe("javascript");
  });

  test("reports Hunk's own extensions as built in", () => {
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("mts")).toBe(true);
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("cts")).toBe(true);
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("ts")).toBe(false);
  });
});

describe("deferred registration", () => {
  test("applies a mapping registered before the first lookup", () => {
    registerFileLanguage("hunkdeferred", "python");
    expect(fileLanguageForPath("foo.hunkdeferred")).toBe("python");
  });

  test("applies a mapping registered after an earlier lookup drained the queue", () => {
    // The queue is emptied on drain, so a late registration has to survive on its own.
    expect(fileLanguageForPath("foo.ts")).toBe("typescript");
    registerFileLanguage("hunklate", "ruby");
    expect(fileLanguageForPath("foo.hunklate")).toBe("ruby");
  });

  test("keeps the last registration for one extension", () => {
    registerFileLanguage("hunkrepeat", "python");
    registerFileLanguage("hunkrepeat", "ruby");
    expect(fileLanguageForPath("foo.hunkrepeat")).toBe("ruby");
  });
});
