import { beforeEach, describe, expect, test } from "bun:test";
import {
  BUILT_IN_FILE_LANGUAGE_EXTENSIONS,
  replaceExtensionFileLanguages,
  type FileLanguageRegistration,
} from "./fileLanguage";
import { fileLanguageForPath } from "./fileLanguageLookup";

/** Replace extension selectors with one test-local registration set. */
function useTestFileLanguages(...registrations: FileLanguageRegistration[]): void {
  replaceExtensionFileLanguages(registrations);
}

beforeEach(() => {
  useTestFileLanguages();
});

describe("custom file language registration", () => {
  test("maps TypeScript module/commonjs extensions to typescript", () => {
    expect(fileLanguageForPath("foo.mts")).toBe("typescript");
    expect(fileLanguageForPath("foo.cts")).toBe("typescript");
    expect(fileLanguageForPath("src/nested/foo.mts")).toBe("typescript");
  });

  test("preserves Pierre's built-in filename detection at any depth", () => {
    expect(fileLanguageForPath("foo.ts")).toBe("typescript");
    expect(fileLanguageForPath("foo.tsx")).toBe("tsx");
    expect(fileLanguageForPath("foo.mjs")).toBe("javascript");
    expect(fileLanguageForPath("foo.cjs")).toBe("javascript");
    expect(fileLanguageForPath("docker/Dockerfile")).toBe("dockerfile");
    expect(fileLanguageForPath("build/tools/Makefile")).toBe("makefile");
  });

  test("reports Hunk's own extensions as built in", () => {
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("mts")).toBe(true);
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("cts")).toBe(true);
    expect(BUILT_IN_FILE_LANGUAGE_EXTENSIONS.has("ts")).toBe(false);
  });

  test("treats extension selectors only as dotted extensions", () => {
    useTestFileLanguages({
      matcher: { kind: "extension", value: "hunklegacy" },
      language: "python",
    });

    expect(fileLanguageForPath("x.hunklegacy")).toBe("python");
    expect(fileLanguageForPath("nested/x.hunklegacy")).toBe("python");
    expect(fileLanguageForPath("hunklegacy")).toBe("text");
    expect(fileLanguageForPath("nested/hunklegacy")).toBe("text");
  });

  test("matches exact filenames at any path depth without altering their characters", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "filename", value: "Hunkfile" },
        language: "python",
      },
      {
        matcher: { kind: "filename", value: " Tool\\Hunkfile " },
        language: "ruby",
      },
      {
        matcher: { kind: "filename", value: " " },
        language: "ruby",
      },
      {
        matcher: { kind: "filename", value: "zero\0name" },
        language: "ruby",
      },
    );

    expect(fileLanguageForPath("Hunkfile")).toBe("python");
    expect(fileLanguageForPath("tools/Hunkfile")).toBe("python");
    expect(fileLanguageForPath("tools/hunkfile")).toBe("text");
    expect(fileLanguageForPath("nested/ Tool\\Hunkfile ")).toBe("ruby");
    expect(fileLanguageForPath("nested/ ")).toBe("ruby");
    expect(fileLanguageForPath("nested/zero\0name")).toBe("ruby");
    // Review paths use `/`; a backslash remains a legal filename character on POSIX.
    expect(fileLanguageForPath("tools\\nested\\Hunkfile")).toBe("text");
  });

  test("matches globs against either the basename or exact review path", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "glob", value: "*.hunkbasename", target: "basename" },
        language: "ruby",
      },
      {
        matcher: { kind: "glob", value: "generated/**/*.hunkpath", target: "path" },
        language: "python",
      },
    );

    expect(fileLanguageForPath("nested/example.hunkbasename")).toBe("ruby");
    expect(fileLanguageForPath("generated/example.hunkpath")).toBe("python");
    expect(fileLanguageForPath("generated/nested/example.hunkpath")).toBe("python");
    expect(fileLanguageForPath("generated\\nested\\example.hunkpath")).toBe("text");
    expect(fileLanguageForPath("source/example.hunkpath")).toBe("text");
  });

  test("treats literal backslash as one glob character and excludes decoded NUL paths", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "glob", value: "foo?bar", target: "basename" },
        language: "python",
      },
      {
        matcher: { kind: "glob", value: "foo??bar", target: "basename" },
        language: "ruby",
      },
    );
    expect(fileLanguageForPath("foo\\bar")).toBe("python");
    expect(fileLanguageForPath("fooXYbar")).toBe("ruby");
    expect(fileLanguageForPath("foo\0bar")).toBe("text");

    useTestFileLanguages({
      matcher: { kind: "glob", value: "foo[\\]bar", target: "basename" },
      language: "ruby",
    });
    expect(fileLanguageForPath("foo\\bar")).toBe("ruby");
    expect(fileLanguageForPath("fooXbar")).toBe("text");
  });

  test("prefers filenames, then globs, then the longest extension", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "extension", value: "hunkpriority" },
        language: "ruby",
      },
      {
        matcher: { kind: "extension", value: "spec.hunkpriority" },
        language: "typescript",
      },
      {
        matcher: { kind: "glob", value: "*.hunkpriority", target: "basename" },
        language: "javascript",
      },
      {
        matcher: { kind: "filename", value: "exact.hunkpriority" },
        language: "python",
      },
    );

    expect(fileLanguageForPath("exact.hunkpriority")).toBe("python");
    expect(fileLanguageForPath("other.hunkpriority")).toBe("javascript");
    expect(fileLanguageForPath("other.spec.hunkpriority")).toBe("javascript");

    useTestFileLanguages(
      {
        matcher: { kind: "extension", value: "hunklongest" },
        language: "ruby",
      },
      {
        matcher: { kind: "extension", value: "spec.hunklongest" },
        language: "typescript",
      },
    );
    expect(fileLanguageForPath("other.spec.hunklongest")).toBe("typescript");
  });

  test("does not let broader selectors override Hunk's reserved extensions", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "filename", value: "special.mts" },
        language: "python",
      },
      {
        matcher: { kind: "glob", value: "*.cts", target: "basename" },
        language: "ruby",
      },
    );

    expect(fileLanguageForPath("special.mts")).toBe("typescript");
    expect(fileLanguageForPath("nested/example.cts")).toBe("typescript");
  });
});

describe("registration replacement", () => {
  test("applies a replacement after an earlier lookup", () => {
    expect(fileLanguageForPath("foo.hunklate")).toBe("text");
    useTestFileLanguages({
      matcher: { kind: "extension", value: "hunklate" },
      language: "ruby",
    });
    expect(fileLanguageForPath("foo.hunklate")).toBe("ruby");
  });

  test("removes selectors that disappear on reload", () => {
    useTestFileLanguages({
      matcher: { kind: "filename", value: "Reloadfile" },
      language: "python",
    });
    expect(fileLanguageForPath("nested/Reloadfile")).toBe("python");

    useTestFileLanguages();
    expect(fileLanguageForPath("nested/Reloadfile")).toBe("text");
  });

  test("keeps the last registration for one selector", () => {
    useTestFileLanguages(
      {
        matcher: { kind: "extension", value: "hunkrepeat" },
        language: "python",
      },
      {
        matcher: { kind: "extension", value: "hunkrepeat" },
        language: "ruby",
      },
    );
    expect(fileLanguageForPath("foo.hunkrepeat")).toBe("ruby");
  });
});
