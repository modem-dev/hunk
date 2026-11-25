/** @jsxImportSource react */
/**
 * The files sidebar: navigation over the review stream, in tree or flat mode.
 *
 * Choosing a file scrolls the stream to it (a `selection/select-file` with a file-top
 * reveal); it never collapses the stream to that file. Rows show the terminal's facts from
 * the shared labels in `core/review/fileLabels.ts`: change-kind letter, filename-first name
 * (`old -> new` for a rename), a note count, and `+N`/`-N` stat badges that hide zeros and
 * mark a truncated count. The terminal prints the note count as `*N`; the page draws a
 * comment icon beside the number and names it ("2 notes").
 *
 * Tree mode is `@pierre/trees`, given the paths in review order (`presorted`), the change
 * kinds as git statuses, and the badges as row decorations. Pierre's tree groups a directory
 * once even when review order leaves and re-enters it, where the terminal's tree repeats the
 * directory row; flat mode follows the shared projection exactly.
 *
 * Each flat row carries the file's "Viewed" checkbox beside its button, checked in the theme's
 * "added" family, with a refresh mark before it when the file changed since it was viewed;
 * tree rows show the same marks as decorations (see `TreeSidebar`). A viewed file's name
 * dims in both modes, and folders show how much of them is viewed (`viewedRollup.ts`). The
 * header checkbox, `V`, and the palette toggle the mark in either mode.
 *
 * Names and directory headings are repository text, drawn through `RevealedText` so a bidi
 * override cannot fake an extension and a zero-width character shows; the tree's paths get the
 * same treatment as plain text (`treePathsOf`).
 */
import { lazy, Suspense, useContext, useMemo } from "react";
import { SessionEndedContext } from "../session/sessionEnded";
import {
  buildReviewFlatSidebarEntries,
  reviewFileChangeGlyph,
  reviewSidebarBadges,
} from "../../core/review/fileLabels";
import { revealReviewHiddenText } from "../../core/review/hiddenText";
import { formatCount } from "../format/lineCounts";
import { RevealedText } from "../format/RevealedText";
import { Icon } from "../icons/Icon";
import { sidebarEntry, type FileSidebarProps } from "./sidebarEntry";
import {
  formatNoteCountLabel,
  formatViewedRollup,
  headingViewedRollups,
  showsViewedRollup,
} from "./viewedRollup";

const TreeSidebar = lazy(() => import("./TreeSidebar"));

/** A note count as a comment icon and the number, named in words for assistive technology. */
function NoteCountBadge({ count }: { count: number }) {
  const label = formatNoteCountLabel(count);
  return (
    <span data-badge="agent-comment" title={label}>
      <Icon name="comment" size={12} />
      {formatCount(count)}
      <span className="visually-hidden">{count === 1 ? " note" : " notes"}</span>
    </span>
  );
}

/** The compact sidebar: directory headings over files, in review order. */
function FlatSidebar({
  entries,
  noteCounts,
  selectedKey,
  onSelectFile,
  viewedStatuses,
  onToggleViewed,
}: Omit<FileSidebarProps, "mode">) {
  const sessionEnded = useContext(SessionEndedContext);
  const rows = useMemo(
    () =>
      buildReviewFlatSidebarEntries({
        files: entries,
        pathOf: (entry) => entry.path,
        entryOf: (entry, depth) => sidebarEntry(entry, depth, noteCounts.get(entry.key) ?? 0),
      }),
    [entries, noteCounts],
  );
  const rollups = useMemo(() => headingViewedRollups(rows, viewedStatuses), [rows, viewedStatuses]);
  return (
    <ul className="flat-sidebar" aria-label="Files">
      {rows.map((row) => {
        if (row.kind !== "file") {
          const rollup = rollups.get(row.id);
          const shown = showsViewedRollup(rollup) ? formatViewedRollup(rollup) : undefined;
          return (
            <li key={row.id} className="flat-group">
              <span className="flat-group-label">
                <RevealedText text={row.label} />
              </span>
              {shown ? (
                <span
                  className="viewed-rollup"
                  data-complete={shown.complete ? "" : undefined}
                  title={shown.label}
                >
                  <span aria-hidden="true">{shown.text}</span>
                  <span className="visually-hidden">{shown.label}</span>
                </span>
              ) : null}
            </li>
          );
        }
        const glyph = reviewFileChangeGlyph(row.changeType, row.isUntracked);
        const selected = row.id === selectedKey;
        const viewed = viewedStatuses?.get(row.id);
        return (
          <li key={row.id} className="flat-row" data-viewed={viewed ?? "unviewed"}>
            <button
              type="button"
              className="flat-file"
              aria-current={selected ? "true" : undefined}
              data-selected={selected ? "" : undefined}
              onClick={() => onSelectFile(row.id)}
              title={revealReviewHiddenText(row.name)}
            >
              <span className="file-glyph" data-role={glyph.role}>
                {glyph.glyph}
              </span>
              <span className="flat-name">
                <RevealedText text={row.name} />
              </span>
              <span className="flat-badges">
                {reviewSidebarBadges(row).map((badge) =>
                  badge.kind === "agent-comment" ? (
                    <NoteCountBadge key={badge.kind} count={noteCounts.get(row.id) ?? 0} />
                  ) : (
                    <span key={badge.kind} data-badge={badge.kind}>
                      {badge.text}
                    </span>
                  ),
                )}
              </span>
            </button>
            {viewed === "changed" ? (
              <span className="changed-mark" title="Changed since viewed">
                <Icon name="refresh" size={13} />
              </span>
            ) : null}
            {onToggleViewed ? (
              <input
                type="checkbox"
                className="flat-viewed"
                checked={viewed === "viewed"}
                disabled={sessionEnded}
                onChange={() => onToggleViewed(row.id)}
                aria-label={`Viewed ${revealReviewHiddenText(row.name)}`}
                title={viewed === "changed" ? "Changed since viewed" : "Viewed"}
              />
            ) : null}
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
