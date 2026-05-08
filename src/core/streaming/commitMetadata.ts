import type { CommitMetadata } from "../types";

/**
 * Parse a verbatim `git log -p` commit header block into structured fields. Tolerant of
 * Merge commits (line dropped) and the `--decorate` annotation on the commit line.
 * Empty input yields a placeholder metadata with empty sha/subject; callers that
 * receive that should treat the commit as anonymous rather than crashing.
 */
export function parseCommitMetadata(rawHeader: string): CommitMetadata {
  const lines = rawHeader.split("\n");
  let sha = "";
  let author: string | undefined;
  let date: string | undefined;
  const bodyLines: string[] = [];
  let inHeader = true;

  for (const line of lines) {
    if (inHeader) {
      const commitMatch = line.match(/^commit ([0-9a-f]+)/);
      if (commitMatch) {
        sha = commitMatch[1]!;
        continue;
      }
      const authorMatch = line.match(/^Author:\s*(.+)$/);
      if (authorMatch) {
        author = authorMatch[1]!.trim();
        continue;
      }
      const dateMatch = line.match(/^Date:\s*(.+)$/);
      if (dateMatch) {
        date = dateMatch[1]!.trim();
        continue;
      }
      if (/^Merge:\s/.test(line)) continue;
      // First non-header line ends the header block. Empty line after Author/Date is
      // the conventional separator; the next non-empty line is the subject.
      if (line.trim().length === 0 && bodyLines.length === 0) continue;
      inHeader = false;
    }
    bodyLines.push(line);
  }

  const body = bodyLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const subject = body.split("\n")[0]?.trim() ?? "";
  const shortSha = sha.slice(0, 7);

  return { sha, shortSha, subject, author, date, body, rawHeader };
}
