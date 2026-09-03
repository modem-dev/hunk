import { describe, expect, test } from "bun:test";
import { applyExtensionFileLanguages } from "../../apply";
import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import { runExtensionFactory } from "../../runExtension";
import { createEmptyExtensionRegistry, type ExtensionLoadIssue } from "../../types";
import { getBundledFileLanguages } from ".";
import registerStarlarkFileLanguages, { STARLARK_FILE_LANGUAGE_SELECTORS } from "./starlark";

describe("bundled Starlark file languages", () => {
  test("lists the Linguist Starlark selectors", () => {
    const matchers = getBundledFileLanguages().map((entry) => entry.matcher);

    expect(matchers).toContainEqual({ kind: "extension", value: "bzl" });
    expect(matchers).toContainEqual({ kind: "extension", value: "star" });
    expect(matchers).toContainEqual({ kind: "extension", value: "bazel" });
    expect(matchers).toContainEqual({ kind: "extension", value: "bzlmod" });
    expect(matchers).toContainEqual({ kind: "extension", value: "sky" });
    expect(matchers).toContainEqual({ kind: "filename", value: "BUILD" });
    expect(matchers).toContainEqual({ kind: "filename", value: "WORKSPACE" });
    expect(matchers).toContainEqual({ kind: "filename", value: "BUCK" });
    expect(matchers).toContainEqual({ kind: "filename", value: "Tiltfile" });
    expect(getBundledFileLanguages().every((entry) => entry.language === "python")).toBe(true);
  });

  test("registers the same selectors through the public factory API", () => {
    const registry = createEmptyExtensionRegistry();
    const issues: ExtensionLoadIssue[] = [];
    runExtensionFactory({
      metadata: {
        id: HUNK_VENDOR_EXTENSION_ID,
        sourcePath: "hunk:bundled/languages/starlark",
        origin: "bundled",
      },
      registry,
      issues,
      factory: registerStarlarkFileLanguages,
    });

    expect(issues).toEqual([]);
    expect(registry.fileLanguages.map((entry) => entry.matcher)).toEqual(
      STARLARK_FILE_LANGUAGE_SELECTORS.map((entry) => entry.matcher),
    );
  });

  test("highlights Bazel and Starlark paths as Python after apply", async () => {
    const { fileLanguageForPath } = await import("../../../core/changeset/fileLanguageLookup");
    expect(applyExtensionFileLanguages(createEmptyExtensionRegistry())).toEqual([]);

    expect(fileLanguageForPath("defs.bzl")).toBe("python");
    expect(fileLanguageForPath("tools/defs.bzl")).toBe("python");
    expect(fileLanguageForPath("rules.star")).toBe("python");
    expect(fileLanguageForPath("copy.bara.sky")).toBe("python");
    expect(fileLanguageForPath("BUILD.bazel")).toBe("python");
    expect(fileLanguageForPath("pkg/nested/MODULE.bazel")).toBe("python");
    expect(fileLanguageForPath("WORKSPACE.bzlmod")).toBe("python");
    expect(fileLanguageForPath("BUILD")).toBe("python");
    expect(fileLanguageForPath("pkg/BUILD")).toBe("python");
    expect(fileLanguageForPath("a/b/c/WORKSPACE")).toBe("python");
    expect(fileLanguageForPath("third_party/BUCK")).toBe("python");
    expect(fileLanguageForPath("Tiltfile")).toBe("python");
    // `.bazelrc` is a flag file rather than Starlark.
    expect(fileLanguageForPath(".bazelrc")).toBe("text");
  });
});
