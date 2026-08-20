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
    // Python is a default for Starlark, not a claim, so an extension may replace it.
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("bzl")).toBe(false);
  });

  test("highlights Bazel and Starlark files as Python", () => {
    expect(fileLanguageForPath("defs.bzl")).toBe("python");
    expect(fileLanguageForPath("tools/defs.bzl")).toBe("python");
    expect(fileLanguageForPath("rules.star")).toBe("python");
    expect(fileLanguageForPath("copy.bara.sky")).toBe("python");
    expect(fileLanguageForPath("BUILD.bazel")).toBe("python");
    expect(fileLanguageForPath("pkg/nested/MODULE.bazel")).toBe("python");
    expect(fileLanguageForPath("WORKSPACE.bzlmod")).toBe("python");
    expect(fileLanguageForPath("Tiltfile")).toBe("python");
  });
});

describe("extensionless filename lookups", () => {
  test("resolves Bazel package files at any depth", () => {
    expect(fileLanguageForPath("BUILD")).toBe("python");
    expect(fileLanguageForPath("pkg/BUILD")).toBe("python");
    expect(fileLanguageForPath("a/b/c/WORKSPACE")).toBe("python");
    expect(fileLanguageForPath("third_party/BUCK")).toBe("python");
  });

  test("resolves Pierre's own special filenames at any depth", () => {
    expect(fileLanguageForPath("Dockerfile")).toBe("dockerfile");
    expect(fileLanguageForPath("docker/Dockerfile")).toBe("dockerfile");
    // Windows-style separators reach Hunk from user-supplied paths, not from VCS output.
    expect(fileLanguageForPath("build\\tools\\Makefile")).toBe("makefile");
  });

  test("leaves paths with no matching grammar as plain text", () => {
    expect(fileLanguageForPath("notes")).toBe("text");
    expect(fileLanguageForPath("path/to/notes")).toBe("text");
    // `.bazelrc` is a flag file rather than Starlark, so it stays unhighlighted.
    expect(fileLanguageForPath(".bazelrc")).toBe("text");
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
