/**
 * Cleans dirty patch text into the parser-safe form the diff model is built from.
 *
 * Patch text reaches Hunk colored by a pager, CRLF-terminated, or wrapped in `git log`
 * metadata, and the parser accepts none of that. "Sanitize" is the rewrite of that text;
 * "normalize" stays reserved for canonicalizing paths (`core/changeset/diffPaths.ts`), so a reader can
 * tell the two apart by name.
 *
 * Callers that need moved-line markers must read Git's SGR colors before calling this — the
 * escape sequences carrying them do not survive here.
 */
import { sanitizeGitPatch, type SanitizedGitPatch } from "./gitFormat";
import { stripGitLogMetadata } from "./gitLog";

export { escapeUntrackedPatchPath } from "../../lib/patchPath";

/** Remove terminal escape sequences so Git-colored pager input still parses as plain patch text. */
export function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Sanitize patch text and retain exact decoded Git paths beside parser-safe headers. */
export function sanitizePatch(patchText: string): SanitizedGitPatch {
  return sanitizeGitPatch(
    stripGitLogMetadata(stripTerminalControl(patchText.replaceAll("\r\n", "\n"))),
  );
}

/** Sanitize patch text into the parser-friendly form used by text-only callers. */
export function sanitizePatchText(patchText: string) {
  return sanitizePatch(patchText).text;
}
