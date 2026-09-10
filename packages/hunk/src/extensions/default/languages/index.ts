import { HUNK_VENDOR_EXTENSION_ID } from "../../extensionIds";
import type { RegisteredFileLanguage } from "../../types";
import { STARLARK_FILE_LANGUAGE_SELECTORS } from "./starlark";

/**
 * Bundled file-language selectors.
 *
 * `applyExtensionFileLanguages` prepends these ahead of user extensions so shipped
 * defaults stay active under `--no-extensions` and remain replaceable by a later
 * registration. This module stays free of `runExtension` so the startup graph can
 * reach apply without loading the diff engine.
 */

/** Return the shipped file-language selectors for the apply path. */
export function getBundledFileLanguages(): readonly RegisteredFileLanguage[] {
  return STARLARK_FILE_LANGUAGE_SELECTORS.map((entry) => ({
    extensionId: HUNK_VENDOR_EXTENSION_ID,
    matcher: entry.matcher,
    language: entry.language,
  }));
}
