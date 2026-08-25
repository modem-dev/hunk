/** Escape only path characters that break unified-diff header parsing. */
export function escapeUntrackedPatchPath(path: string) {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
