/** @jsxImportSource react */
/**
 * The files sidebar: navigation over the review stream, in tree or flat mode.
 *
 * Choosing a file scrolls the stream to it (a `selection/select-file` with a file-top
 * reveal); it never collapses the stream to that file. Rows show the terminal's facts from
 * the shared labels in `core/review/fileLabels.ts`: change-kind letter, filename-first name
 * (`old -> new` for a rename), `*N` note badge, and `+N`/`-N` stat badges that hide zeros and
 * mark a truncated count.
 *
 * Tree mode is `@pierre/trees`, given the paths in review order (`presorted`), the change
 * kinds as git statuses, and the badges as row decorations. Pierre's tree groups a directory
 * once even when review order leaves and re-enters it, where the terminal's tree repeats the
 * directory row; flat mode follows the shared projection exactly.
 */
import { lazy, Suspense, useMemo } from "react";
import {
  buildReviewFlatSidebarEntries,
  reviewFileChangeGlyph,
  reviewSidebarBadges,
} from "../../core/review/fileLabels";
import { sidebarEntry, type FileSidebarProps } from "./sidebarEntry";

const TreeSidebar = lazy(() => import("./TreeSidebar"));

/** The compact sidebar: directory headings over files, in review order. */
function FlatSidebar({ entries, selectedKey, onSelectFile }: Omit<FileSidebarProps, "mode">) {
  const rows = useMemo(
    () =>
      buildReviewFlatSidebarEntries({
        files: entries,
        pathOf: (entry) => entry.path,
        entryOf: sidebarEntry,
      }),
    [entries],
  );
  return (
    <ul className="flat-sidebar" aria-label="Files">
      {rows.map((row) => {
        if (row.kind !== "file") {
          return (
            <li key={row.id} className="flat-group">
              {row.label}
            </li>
          );
        }
        const glyph = reviewFileChangeGlyph(row.changeType, row.isUntracked);
        const selected = row.id === selectedKey;
        return (
          <li key={row.id}>
            <button
              type="button"
              className="flat-file"
              aria-current={selected ? "true" : undefined}
              data-selected={selected ? "" : undefined}
              onClick={() => onSelectFile(row.id)}
              title={row.name}
            >
              <span className="file-glyph" data-role={glyph.role}>
                {glyph.glyph}
              </span>
              <span className="flat-name">{row.name}</span>
              <span className="flat-badges">
                {reviewSidebarBadges(row).map((badge) => (
                  <span key={badge.kind} data-badge={badge.kind}>
                    {badge.text}
                  </span>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The sidebar in the chosen mode. */
export function FileSidebar({ mode, ...props }: FileSidebarProps) {
  return mode === "tree" ? (
    <Suspense fallback={<p className="sidebar-loading muted">Loading files…</p>}>
      <TreeSidebar {...props} />
    </Suspense>
  ) : (
    <FlatSidebar {...props} />
  );
}
