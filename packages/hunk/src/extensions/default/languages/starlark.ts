import type { ExtensionFileLanguageMatcher, HunkExtensionAPI } from "hunkdiff/extension";

/**
 * Bazel/Starlark path → Python highlight selectors.
 *
 * Starlark has no grammar of its own. GitHub Linguist classifies it with
 * `tm_scope: source.python`, so Python is the intended rendering rather than a
 * stand-in. Extension and filename selectors follow Linguist's key list; the
 * `bazel` and `bzlmod` extensions also cover `BUILD.bazel`, `MODULE.bazel`,
 * `REPO.bazel`, `VENDOR.bazel`, and `WORKSPACE.bzlmod` without naming each one.
 *
 * Kept as plain data so apply can prepend these without loading the extension
 * host or the diff engine. The factory below is the same public API a user
 * extension would call.
 */
export const STARLARK_FILE_LANGUAGE_SELECTORS: readonly {
  matcher: ExtensionFileLanguageMatcher;
  language: string;
}[] = [
  ...(["bzl", "star", "bazel", "bzlmod", "sky"] as const).map((value) => ({
    matcher: { kind: "extension" as const, value },
    language: "python",
  })),
  ...(["BUILD", "WORKSPACE", "BUCK", "Tiltfile"] as const).map((value) => ({
    matcher: { kind: "filename" as const, value },
    language: "python",
  })),
];

/** Register the bundled Starlark selectors through the public extension API. */
export default function registerStarlarkFileLanguages(hunk: HunkExtensionAPI): void {
  for (const { matcher, language } of STARLARK_FILE_LANGUAGE_SELECTORS) {
    hunk.registerFileLanguage(matcher, language);
  }
}
