import { useState, type ReactNode } from "react";
import type {
  ExtensionDiffFile,
  ExtensionFileViewLayout,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSourceRange,
  ExtensionFileViewSpan,
  ExtensionFactory,
} from "hunkdiff/extension";

/** Build one stateful painter as a closure over hunk semantics, not host payload. */
function hunkCard(
  title: string,
  detail: string,
  tone: ExtensionFileViewSpan["tone"],
): (props: ExtensionFileViewRowComponentProps) => ReactNode {
  return function HunkCard({ width, height, selected, rowIndex, theme }) {
    const [expanded, setExpanded] = useState(false);
    const marker = selected ? "▶" : " ";
    return (
      <box
        style={{ width, height, flexDirection: "column" }}
        onMouseUp={(event) => {
          if (event.button !== 0 || event.isDragging) return;
          event.preventDefault();
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
      >
        <text
          content={`${marker} ${title}`}
          style={{ fg: tone === "added" ? theme.fileNew : theme.accent }}
        />
        <text content={`  ${expanded ? detail : `row ${rowIndex} · click for detail`}`} />
      </box>
    );
  };
}

/** Omit the `[0, 0]` range Pierre uses for an added/deleted file's nonexistent side. */
function hunkSourceRanges(hunk: {
  oldRange?: readonly [number, number];
  newRange?: readonly [number, number];
}): ExtensionFileViewSourceRange[] {
  return [
    ...(hunk.oldRange && hunk.oldRange[0] >= 1
      ? [{ side: "old" as const, range: hunk.oldRange }]
      : []),
    ...(hunk.newRange && hunk.newRange[0] >= 1
      ? [{ side: "new" as const, range: hunk.newRange }]
      : []),
  ];
}

/** Build the deterministic two-row-per-hunk layout used by the live TSX example. */
export function createJsxFileViewLayout(file: ExtensionDiffFile): ExtensionFileViewLayout | null {
  const hunks = file.hunks ?? [];
  if (hunks.length < 2) return null;

  const rows = hunks.flatMap((item) => {
    const range = item.newRange ?? item.oldRange;
    const rangeLabel = range ? `lines ${range[0]}–${range[1]}` : "unknown lines";
    return [
      {
        id: `hunk-${item.index}-summary`,
        spans: [
          {
            text: `Hunk ${item.index + 1}: ${item.header}`,
            tone: "accent" as const,
          },
        ],
        sourceRanges: hunkSourceRanges(item),
        component: {
          height: 2,
          render: hunkCard(`Hunk ${item.index + 1}`, `${rangeLabel} · ${item.header}`, "added"),
        },
      },
      {
        id: `hunk-${item.index}-detail`,
        spans: [{ text: `${rangeLabel} (symbolic fallback)`, tone: "muted" as const }],
        component: {
          height: 2,
          render: hunkCard("Changed range", rangeLabel, "accent"),
        },
      },
    ];
  });

  return {
    rows,
    hunkRows: hunks.map((_, position) => ({
      startRow: position * 2,
      endRow: position * 2 + 1,
    })),
  };
}

/** Register an opt-in multi-hunk TSX presentation proof of concept. */
const register: ExtensionFactory = (hunk) => {
  hunk.registerFileView({
    id: "jsx-cards",
    title: "JSX hunk cards (POC)",
    matches: (file) => (file.hunks?.length ?? 0) >= 2,
    layout: ({ file }) => createJsxFileViewLayout(file),
  });

  hunk.registerCommand(
    { id: "toggle-jsx-cards", title: "Toggle JSX hunk cards (POC)", key: "f8" },
    (ctx) => ctx.fileViews.toggle("jsx-cards"),
  );
};

export default register;
