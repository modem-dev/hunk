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

/**
 * Build a two-row compact summary of a commit. The first row carries the structured
 * commit/Author/Date header; the second row carries the subject (with the 4-space
 * indent that `git log` uses for message lines, so it reads consistently with the
 * verbatim full view). Fields absent in the parsed metadata are skipped quietly so
 * the row stays well-formed for partial inputs.
 */
export function compactCommitHeader(metadata: CommitMetadata): string {
  const headerParts: string[] = [];
  headerParts.push(`commit ${metadata.shortSha || metadata.sha || "—"}`);
  if (metadata.author) headerParts.push(`Author: ${metadata.author}`);
  if (metadata.date) {
    // Truncate to the leading YYYY-MM-DD portion so the line stays short and the
    // date format is uniform regardless of whether the source had a time/zone.
    const datePart = metadata.date.split(/\s/)[0] ?? metadata.date;
    headerParts.push(`Date: ${datePart}`);
  }

  const headerRow = headerParts.join("  ");
  if (!metadata.subject) return headerRow;
  return `${headerRow}\n    ${metadata.subject}`;
}

/**
 * Truncate a verbatim commit header block to keep only the structured headers
 * (commit/Author/Date/Merge), the blank separator, and the subject (first message
 * line) — dropping the extended body. Used by the renderer's "collapse" view so the
 * commit context (sha, who/when, headline) stays visible while reclaiming the
 * vertical space taken by long commit messages.
 */
export function collapsedCommitHeader(rawHeader: string): string {
  const lines = rawHeader.replace(/\n+$/, "").split("\n");
  const out: string[] = [];
  let pastHeaders = false;

  for (const line of lines) {
    if (!pastHeaders) {
      if (/^commit |^Author:|^Date:|^Merge:/.test(line)) {
        out.push(line);
        continue;
      }
      pastHeaders = true;
    }
    out.push(line);
    // First non-blank line after the header rows is the subject. Stop after it.
    if (line.trim().length > 0) break;
  }

  return out.join("\n");
}
