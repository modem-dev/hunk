import type { SupportedLanguages } from "@pierre/diffs";

/**
 * Records file-extension and filename → highlight-language mappings without loading the diff
 * engine.
 *
 * Registration happens during startup, on every invocation, while the mappings are only read
 * when a changeset is built. Applying them eagerly would pull the whole diff engine — and its
 * syntax grammars — into commands that never render anything, so this module holds them as
 * plain data and `fileLanguageLookup` applies them at the first lookup instead.
 *
 * Keep this module free of runtime imports from `@pierre/diffs`; that is the only thing making
 * the deferral worth anything.
 */

// Pierre omits these TypeScript extensions, so Hunk registers them itself.
const HUNK_RESERVED_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

/**
 * Maps Bazel and Starlark files to Python, keyed by extension and by exact filename.
 *
 * Starlark has no grammar of its own and is not waiting for one: GitHub Linguist classifies it
 * with `tm_scope: source.python`, so Python is the intended rendering rather than a stand-in
 * Hunk invented. The `bazel` and `bzlmod` extensions cover `BUILD.bazel`, `MODULE.bazel`,
 * `WORKSPACE.bzlmod`, and Bazel's newer `REPO.bazel`/`VENDOR.bazel` without naming each one.
 *
 * These stay out of `BUILT_IN_FILE_LANGUAGE_EXTENSIONS` on purpose: an extension shipping a
 * genuine Starlark grammar should be able to replace a Python approximation.
 */
const STARLARK_FILE_LANGUAGES: Record<string, SupportedLanguages> = {
  bzl: "python",
  star: "python",
  bazel: "python",
  bzlmod: "python",
  // Legacy Skylark spelling, still current for Copybara's `copy.bara.sky`.
  sky: "python",
  BUILD: "python",
  WORKSPACE: "python",
  BUCK: "python",
  Tiltfile: "python",
};

/**
 * Extensions Hunk refuses to yield to an extension, in Pierre's dotless lowercase form.
 *
 * Extension-contributed mappings are skipped rather than allowed to shadow
 * these, so a third-party language pack cannot silently break TypeScript
 * highlighting for everyone.
 */
export const BUILT_IN_FILE_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(HUNK_RESERVED_EXTENSIONS),
);

// Hunk's own mappings are seeded here rather than applied on import, so they land in the same
// pass as extension-contributed ones. `apply.ts` refuses extension mappings that collide with
// BUILT_IN_FILE_LANGUAGE_EXTENSIONS, so the reserved ones cannot lose to a later registration;
// the Starlark defaults intentionally can.
const pendingFileLanguages = new Map<string, string>([
  ...Object.entries(HUNK_RESERVED_EXTENSIONS),
  ...Object.entries(STARLARK_FILE_LANGUAGES),
]);

/**
 * Map one dotless, lowercased file extension to a highlight language.
 *
 * Pierre's language union is closed, but extensions supply plain strings; an
 * unknown language simply fails to match a grammar at render time, which is a
 * better failure than refusing the registration outright.
 *
 * The mapping takes effect at the next lookup rather than immediately. Nothing reads the
 * language table except `fileLanguageLookup`, so the delay is not observable.
 */
export function registerFileLanguage(extension: string, language: string) {
  pendingFileLanguages.set(extension, language);
}

/**
 * Hand over every mapping registered since the last drain, emptying the queue.
 *
 * Draining rather than replaying keeps repeat lookups free once the queue is empty, while a
 * registration made after the first lookup still lands on the next one.
 */
export function drainPendingFileLanguages(): Array<[string, string]> {
  const drained = [...pendingFileLanguages];
  pendingFileLanguages.clear();
  return drained;
}
