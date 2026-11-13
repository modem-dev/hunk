/**
 * Extracts one hunk's raw text, from its `@@` header through its last body line, from a file's
 * patch.
 *
 * Hunk ordinals follow the `@@` lines in the file patch, which is the same order the parsed
 * `metadata.hunks` array uses.
 */
export function extractHunk(filePatch: string, hunkIndex: number): string | undefined {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
    return undefined;
  }

  const lines = filePatch.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Body lines always carry a ` `, `+`, `-`, or `\` prefix, so only hunk headers start with `@@`.
  const hunkStarts = lines.flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
  const start = hunkStarts[hunkIndex];
  if (start === undefined) {
    return undefined;
  }

  const end = hunkStarts[hunkIndex + 1] ?? lines.length;
  return `${lines.slice(start, end).join("\n")}\n`;
}
