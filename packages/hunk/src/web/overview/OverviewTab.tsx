/** @jsxImportSource react */
/**
 * The Overview tab: the review's shape at a glance, from the shared overview selector.
 *
 * Every figure is `selectReviewOverview`'s (`core/review/overview.ts`) over the page's visible
 * files and the shared state's notes; this component only lays them out. Bars are horizontal
 * stacks of the theme's added and removed badge colors, decorative only: each row states its
 * numbers as text, with `+` and `−` signs, so nothing depends on color. Every row naming a
 * file or a directory jumps to it in the stream (a directory to its first file).
 */
import { Icon } from "../icons/Icon";
import { useState, type ReactNode } from "react";
import { revealReviewHiddenText } from "../../core/review/hiddenText";
import { formatCount, formatFileCount } from "../format/lineCounts";
import { RevealedText } from "../format/RevealedText";
import {
  REVIEW_FILE_ROLES,
  REVIEW_MEANINGFUL_FILE_ROLES,
  type ReviewFileRole,
} from "../../core/review/fileRoles";
import type {
  ReviewOverview,
  ReviewOverviewDirectory,
  ReviewOverviewTotals,
} from "../../core/review/overview";
import { SIZE_BADGE_TITLE, SIZE_LABELS } from "./sizeBadge";

export interface OverviewTabProps {
  overview: ReviewOverview;
  /** Jump the stream to one file. */
  onSelectFile: (fileKey: string) => void;
}

const ROLE_LABELS: Record<ReviewFileRole, string> = {
  source: "Source",
  test: "Tests",
  docs: "Docs",
  generated: "Generated",
  config: "Config",
};

const CHANGE_KIND_LABELS: readonly [keyof ReviewOverview["changeKinds"], string][] = [
  ["modified", "Modified"],
  ["new", "New"],
  ["deleted", "Deleted"],
  ["renamed", "Renamed"],
  ["renamedChanged", "Renamed, changed"],
  ["untracked", "Untracked"],
  ["binary", "Binary"],
  ["tooLarge", "Too large"],
];

/**
 * What "Meaningful" leaves out, worded from the roles `fileRoles.ts` excludes from it, so the
 * sentence follows the rule rather than restating it.
 */
const MEANINGFUL_EXCLUDES = (() => {
  const words = REVIEW_FILE_ROLES.filter((role) => !REVIEW_MEANINGFUL_FILE_ROLES.has(role)).map(
    (role) => ROLE_LABELS[role].toLowerCase(),
  );
  const last = words.pop();
  return words.length > 0 ? `${words.join(", ")}, and ${last}` : (last ?? "");
})();

/** A count with a lower-bound mark when the producer truncated it. */
function count(value: number, truncated: boolean) {
  return truncated ? `≥${formatCount(value)}` : formatCount(value);
}

/** `+A −D`, with lower-bound marks, as two separately colored spans. */
function Churn({ additions, deletions, truncated }: Omit<ReviewOverviewTotals, "files">) {
  return (
    <span className="overview-churn">
      <span className="stat-added">{`+${count(additions, truncated)}`}</span>
      <span className="stat-removed">{`−${count(deletions, truncated)}`}</span>
    </span>
  );
}

/** A stacked bar, scaled against `scale` changed lines; decorative. */
function ChurnBar({
  additions,
  deletions,
  scale,
}: {
  additions: number;
  deletions: number;
  scale: number;
}) {
  const total = Math.max(1, scale);
  return (
    <span className="overview-bar" aria-hidden="true">
      <span className="overview-bar-added" style={{ width: `${(additions / total) * 100}%` }} />
      <span className="overview-bar-removed" style={{ width: `${(deletions / total) * 100}%` }} />
    </span>
  );
}

/** One titled section. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overview-section" aria-label={title}>
      <h3 className="overview-heading">{title}</h3>
      {children}
    </section>
  );
}

/** Files, in words. */
function files(value: number) {
  return formatFileCount(value);
}

/** One directory row and, when expanded, its subdirectories. */
function DirectoryRows({
  directory,
  depth,
  scale,
  onSelectFile,
}: {
  directory: ReviewOverviewDirectory;
  depth: number;
  scale: number;
  onSelectFile: (fileKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = directory.children.length > 0;
  return (
    <li>
      <div className="overview-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <button
          type="button"
          className="overview-disclosure"
          aria-label={`Subdirectories of ${revealReviewHiddenText(directory.path)}`}
          aria-expanded={hasChildren ? expanded : undefined}
          style={hasChildren ? undefined : { visibility: "hidden" }}
          onClick={() => setExpanded((current) => !current)}
        >
          {hasChildren ? (
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          ) : null}
        </button>
        <button
          type="button"
          className="overview-name"
          title={`Jump to ${revealReviewHiddenText(directory.path)}/`}
          onClick={() => onSelectFile(directory.firstFileKey)}
        >
          <RevealedText text={`${directory.name}/`} />
        </button>
        <span className="overview-count">{formatCount(directory.files)}</span>
        <Churn {...directory} />
        <ChurnBar {...directory} scale={scale} />
      </div>
      {expanded && hasChildren ? (
        <ul className="overview-tree">
          {directory.children.map((child) => (
            <DirectoryRows
              key={child.path}
              directory={child}
              depth={depth + 1}
              scale={scale}
              onSelectFile={onSelectFile}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The Overview tab body. */
export function OverviewTab({ overview, onSelectFile }: OverviewTabProps) {
  const { totals, meaningful } = overview;
  const totalChurn = totals.additions + totals.deletions;
  const largestChurn = overview.largestFiles[0]
    ? overview.largestFiles[0].additions + overview.largestFiles[0].deletions
    : 0;
  const directoryScale = Math.max(
    1,
    ...overview.directories.children.map((child) => child.additions + child.deletions),
  );

  // A kind no file has is noise; the section keeps only what happened.
  const changeKinds = CHANGE_KIND_LABELS.filter(([kind]) => overview.changeKinds[kind] > 0);

  if (totals.files === 0) {
    return <p className="overview-empty">No files to summarize yet.</p>;
  }

  return (
    <div className="overview" data-testid="overview">
      <Section title="Summary">
        <div className="overview-summary">
          <span className="overview-size" data-size={overview.sizeClass} title={SIZE_BADGE_TITLE}>
            <span className="overview-size-letter">{overview.sizeClass}</span>
            <span className="overview-size-label">{SIZE_LABELS[overview.sizeClass]}</span>
          </span>
          <dl className="overview-totals">
            <div>
              <dt>All changes</dt>
              <dd data-testid="overview-total">
                <span className="overview-count">{files(totals.files)}</span>
                <Churn {...totals} />
              </dd>
            </div>
            <div>
              <dt title="Excludes tests, docs, and generated files">Meaningful</dt>
              <dd data-testid="overview-meaningful">
                <span className="overview-count">{files(meaningful.files)}</span>
                <Churn {...meaningful} />
              </dd>
            </div>
          </dl>
        </div>
        <ChurnBar {...totals} scale={totalChurn} />
        <p className="overview-note" data-testid="overview-meaningful-note">
          {`Meaningful leaves out ${MEANINGFUL_EXCLUDES} files.`}
        </p>
        {totals.truncated ? (
          <p className="overview-note">
            ≥ marks a lower bound: some files were too large to count.
          </p>
        ) : null}
        {overview.viewed ? (
          <p className="overview-viewed" data-testid="overview-viewed">
            <span>{`${formatCount(overview.viewed.files)} of ${files(overview.viewed.total)} viewed`}</span>
            <progress value={overview.viewed.files} max={overview.viewed.total} />
          </p>
        ) : null}
      </Section>

      <Section title="By role">
        <table className="overview-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col" className="numeric">
                Files
              </th>
              <th scope="col" className="numeric">
                Lines
              </th>
              <th scope="col">
                <span className="visually-hidden">Share</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {REVIEW_FILE_ROLES.map((role) => {
              const row = overview.roles[role];
              if (row.files === 0) return null;
              return (
                <tr key={role}>
                  <th scope="row">{ROLE_LABELS[role]}</th>
                  <td className="numeric">{formatCount(row.files)}</td>
                  <td className="numeric">
                    <Churn {...row} />
                  </td>
                  <td className="bar-cell">
                    <ChurnBar {...row} scale={totalChurn} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {changeKinds.length > 0 ? (
        <Section title="Change kinds">
          <dl className="overview-kinds">
            {changeKinds.map(([kind, label]) => (
              <div key={kind}>
                <dt>{label}</dt>
                <dd>{formatCount(overview.changeKinds[kind])}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      {overview.directories.children.length > 0 ? (
        <Section title="Directories">
          <ul className="overview-tree" aria-label="Directories by changed lines">
            {overview.directories.children.map((directory) => (
              <DirectoryRows
                key={directory.path}
                directory={directory}
                depth={0}
                scale={directoryScale}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {overview.largestFiles.length > 0 ? (
        <Section title="Largest files">
          <ol className="overview-list">
            {overview.largestFiles.map((file) => (
              <li key={file.fileKey} className="overview-row">
                <button
                  type="button"
                  className="overview-name"
                  title={`Jump to ${revealReviewHiddenText(file.path)}`}
                  onClick={() => onSelectFile(file.fileKey)}
                >
                  <RevealedText text={file.path} />
                </button>
                <Churn {...file} />
                <ChurnBar {...file} scale={largestChurn} />
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section title="Notes">
        {overview.notesByFile.length === 0 ? (
          <p className="overview-note">No notes yet.</p>
        ) : (
          <table className="overview-table" data-testid="overview-notes">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col" className="numeric">
                  Agent
                </th>
                <th scope="col" className="numeric">
                  Reviewer
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.notesByFile.map((entry) => (
                <tr key={entry.fileKey}>
                  <th scope="row">
                    <button
                      type="button"
                      className="overview-name"
                      title={`Jump to ${revealReviewHiddenText(entry.path)}`}
                      onClick={() => onSelectFile(entry.fileKey)}
                    >
                      <RevealedText text={entry.path} />
                    </button>
                  </th>
                  <td className="numeric">{entry.agent}</td>
                  <td className="numeric">{entry.reviewer}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="numeric">{overview.noteTotals.agent}</td>
                <td className="numeric">{overview.noteTotals.reviewer}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Section>
    </div>
  );
}
