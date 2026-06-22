import { createContext, useContext } from "react";
import type { AppTheme } from "../themes";
import type { DiffRow, RenderSpan, SplitLineCell, StackLineCell } from "./pierre";

interface SearchHighlightContextValue {
  query: string;
}

const SearchHighlightContext = createContext<SearchHighlightContextValue>({ query: "" });

export function SearchHighlightProvider({
  query,
  children,
}: {
  query: string;
  children: React.ReactNode;
}) {
  return (
    <SearchHighlightContext.Provider value={{ query }}>{children}</SearchHighlightContext.Provider>
  );
}

export function useSearchHighlightQuery() {
  return useContext(SearchHighlightContext).query;
}

/** Split styled spans at every case-insensitive occurrence of one query string. */
export function applyHighlightToSpans(
  spans: RenderSpan[],
  query: string,
  theme: AppTheme,
): RenderSpan[] {
  if (!query) {
    return spans;
  }

  const needle = query.toLowerCase();
  const text = spans.map((span) => span.text).join("");
  if (text.length === 0 || needle.length === 0) {
    return spans;
  }

  const lowerText = text.toLowerCase();
  const isHit: boolean[] = Array.from({ length: text.length }, () => false);
  let cursor = 0;
  while (cursor + needle.length <= text.length) {
    const index = lowerText.indexOf(needle, cursor);
    if (index < 0) {
      break;
    }
    for (let i = index; i < index + needle.length; i++) {
      isHit[i] = true;
    }
    cursor = index + needle.length;
  }

  if (!isHit.some(Boolean)) {
    return spans;
  }

  const highlightFg = theme.background;
  const highlightBg = theme.accent;
  const out: RenderSpan[] = [];
  let absolute = 0;

  for (const span of spans) {
    if (span.text.length === 0) {
      continue;
    }

    let runStart = 0;
    let runHit = isHit[absolute] ?? false;
    for (let i = 1; i <= span.text.length; i++) {
      const atEnd = i === span.text.length;
      const currentHit = atEnd ? !runHit : (isHit[absolute + i] ?? false);
      if (currentHit !== runHit || atEnd) {
        const sliceEnd = atEnd ? span.text.length : i;
        const runText = span.text.slice(runStart, sliceEnd);
        out.push(
          runHit ? { text: runText, fg: highlightFg, bg: highlightBg } : { ...span, text: runText },
        );
        runStart = sliceEnd;
        runHit = currentHit;
      }
    }
    absolute += span.text.length;
  }

  return out;
}

function highlightSplitCell(cell: SplitLineCell, query: string, theme: AppTheme): SplitLineCell {
  return { ...cell, spans: applyHighlightToSpans(cell.spans, query, theme) };
}

function highlightStackCell(cell: StackLineCell, query: string, theme: AppTheme): StackLineCell {
  return { ...cell, spans: applyHighlightToSpans(cell.spans, query, theme) };
}

/** Return a row with match highlights painted on its rendered spans. */
export function applyHighlightToRow(row: DiffRow, query: string, theme: AppTheme): DiffRow {
  if (!query) {
    return row;
  }

  if (row.type === "split-line") {
    return {
      ...row,
      left: highlightSplitCell(row.left, query, theme),
      right: highlightSplitCell(row.right, query, theme),
    };
  }

  if (row.type === "stack-line") {
    return { ...row, cell: highlightStackCell(row.cell, query, theme) };
  }

  return row;
}
