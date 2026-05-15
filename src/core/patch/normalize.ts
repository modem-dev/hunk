import { normalizeGitPatchPrefixes } from "./gitFormat";
import { stripGitLogMetadata } from "./gitLog";

/** Remove terminal escape sequences so Git-colored pager input still parses as plain patch text. */
export function stripTerminalControl(text: string) {
  return text
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** Normalize patch text into the parser-friendly form used throughout Hunk. */
export function normalizePatchText(patchText: string) {
  return normalizeGitPatchPrefixes(
    stripGitLogMetadata(stripTerminalControl(patchText.replaceAll("\r\n", "\n"))),
  );
}
