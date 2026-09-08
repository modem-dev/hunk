import type {
  ExtensionDiffHunk,
  ExtensionFileViewInput,
  ExtensionFileViewLayout,
  ExtensionFileViewSpan,
  ExtensionFactory,
} from "hunkdiff/extension";

const UNSAFE_DOCUMENT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;

/** Split a complete document with the same newline and final-line convention Hunk validates. */
function documentLines(text: string) {
  const normalized = text.replace(/\r\n?|\n/g, "\n");
  if (normalized.length === 0) return [];
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return body.split("\n");
}

/** Read one real source line, excluding Pierre's zero-line sentinel for a missing side. */
function hunkStartLine(
  lines: readonly string[],
  range: ExtensionDiffHunk["oldRange"] | ExtensionDiffHunk["newRange"],
) {
  const line = range?.[0] ?? 0;
  return line >= 1 && line <= lines.length ? { line, text: lines[line - 1]! } : null;
}

/** Paint a new-side prefix plainly so the remaining code demonstrates a true partial reference. */
function partialNewLineSpans(
  documentId: string,
  line: number,
  text: string,
): ExtensionFileViewSpan[] {
  if (text.length === 0) return [{ text: "∅", tone: "muted" }];
  const indentation = /^\s*/u.exec(text)?.[0].length ?? 0;
  const start = Math.min(text.length - 1, Math.max(1, indentation));
  return [
    { text: text.slice(0, start), tone: "muted" },
    {
      text: text.slice(start),
      syntax: { documentId, line, range: [start, text.length] },
    },
  ];
}

/** Build one compact split-style row per hunk from complete old and new code documents. */
export async function createCodeDocumentLayout(
  input: ExtensionFileViewInput,
): Promise<ExtensionFileViewLayout | null> {
  const hunks = input.file.hunks ?? [];
  if (hunks.length === 0) return null;

  const [oldText, newText] = await Promise.all([
    input.readDocument("old"),
    input.readDocument("new"),
  ]);
  if (
    input.signal.aborted ||
    (oldText === null && newText === null) ||
    (oldText !== null && UNSAFE_DOCUMENT_CONTROL.test(oldText)) ||
    (newText !== null && UNSAFE_DOCUMENT_CONTROL.test(newText))
  ) {
    return null;
  }

  const oldLines = documentLines(oldText ?? "");
  const newLines = documentLines(newText ?? "");
  const rows = hunks.map((hunk, index) => {
    const oldLine = hunkStartLine(oldLines, hunk.oldRange);
    const newLine = hunkStartLine(newLines, hunk.newRange);
    return {
      id: `split:${index}`,
      spans: [
        { text: `OLD ${oldLine?.line ?? "-"} │ `, tone: "muted" as const },
        ...(oldLine
          ? [
              {
                text: oldLine.text,
                syntax: { documentId: "old", line: oldLine.line },
              } as const,
            ]
          : [{ text: "∅", tone: "removed" as const }]),
        { text: `   NEW ${newLine?.line ?? "-"} │ `, tone: "muted" as const },
        ...(newLine
          ? partialNewLineSpans("new", newLine.line, newLine.text)
          : [{ text: "∅", tone: "added" as const }]),
      ],
    };
  });

  return {
    codeDocuments: [
      ...(oldText === null ? [] : [{ id: "old", text: oldText }]),
      ...(newText === null ? [] : [{ id: "new", text: newText }]),
    ],
    rows,
    hunkRows: rows.map((_, index) => ({ startRow: index, endRow: index })),
  };
}

/** Register an opt-in API-v26 code-document presentation for JavaScript and TypeScript. */
const register: ExtensionFactory = (hunk) => {
  hunk.registerFileView({
    id: "code-documents",
    title: "Code documents: old / new",
    matches: (file) => /\.[cm]?[jt]sx?$/iu.test(file.path),
    layout: createCodeDocumentLayout,
  });
};

export default register;
