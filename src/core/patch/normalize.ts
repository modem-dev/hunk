import { normalizeGitPatch, type NormalizedGitPatch } from "./gitFormat";
import { stripGitLogMetadata } from "./gitLog";

/** Escape only path characters that break unified-diff header parsing. */
export function escapeUntrackedPatchPath(path: string) {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** Remove terminal escape sequences so Git-colored pager input still parses as plain patch text. */
export function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Normalize patch text and retain exact decoded Git paths beside parser-safe headers. */
export function normalizePatch(patchText: string): NormalizedGitPatch {
  return normalizeGitPatch(
    stripGitLogMetadata(stripTerminalControl(patchText.replaceAll("\r\n", "\n"))),
  );
}

/** Normalize patch text into the parser-friendly form used by text-only callers. */
export function normalizePatchText(patchText: string) {
  return normalizePatch(patchText).text;
}
