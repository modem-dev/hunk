import type {
  ExtensionVcsStatusFact,
  ExtensionVcsStatusPath,
  ExtensionVcsStatusPathState,
  ExtensionVcsStatusWorktreeSummary,
  ExtensionVcsStatusSnapshot,
  ExtensionVcsStatusUpstream,
} from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { AppTheme } from "../themes";
import { foreground } from "../history/staticProjection";
import { groupStatusPaths } from "./pathGroups";

/** Escape control characters visibly so legal paths cannot forge extra status rows. */
export function statusDisplayText(value: string) {
  return sanitizeTerminalLine(
    value.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t"),
  );
}

/** Format upstream relations without treating local FETCH_HEAD metadata as an attested fetch age. */
export function formatStatusUpstream(fact: ExtensionVcsStatusFact<ExtensionVcsStatusUpstream>) {
  if (fact.state !== "ready")
    return `Upstream ${fact.state}: ${statusDisplayText(fact.state === "error" ? fact.message : fact.reason)}`;
  const upstream = fact.value;
  if (upstream.kind === "none") return "No upstream";
  if (upstream.kind === "detached") return "Detached HEAD";
  if (upstream.kind === "unborn") return "No commits yet";
  if (upstream.kind === "missing")
    return `Missing upstream ref: ${statusDisplayText(upstream.name)}`;
  if (upstream.kind !== "tracked") return "Upstream unknown";
  const relation = [
    upstream.ahead ? `${upstream.ahead} ahead` : "",
    upstream.behind ? `${upstream.behind} behind` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // The current provenance attests only a local file mtime, not when this upstream was fetched.
  return `${relation || "Aligned with"} ${statusDisplayText(upstream.name)}`;
}

export type StatusTextRole = "text" | "muted" | "accent" | "staged" | "unstaged" | "conflict";

export interface StatusTextSpan {
  text: string;
  role: StatusTextRole;
}

export interface StatusTextFacts {
  primary: StatusTextSpan[];
  secondary: StatusTextSpan[];
}

export const STATUS_WORKTREES_HEADING = "── Other worktrees ──";
const PATH_LABELS: Record<ExtensionVcsStatusPathState, string> = {
  unchanged: "",
  modified: "modified",
  added: "new file",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  "type-changed": "type changed",
  unmerged: "unmerged",
  untracked: "untracked",
};

/** Resolve staging roles from shared theme signs, never from file change-type colors. */
export function statusTextColor(theme: AppTheme, role: StatusTextRole) {
  if (role === "staged") return theme.addedSignColor;
  if (role === "unstaged") return theme.removedSignColor;
  if (role === "conflict") return theme.accent;
  return theme[role];
}

/** Join semantic spans for uncolored output and terminal measurement. */
export function statusPlainText(spans: readonly StatusTextSpan[]) {
  return spans.map((span) => span.text).join("");
}

/** Name each changed staging side explicitly; group membership labels ordinary untracked files. */
export function formatStatusPath(path: ExtensionVcsStatusPath): StatusTextFacts {
  const staged = path.index !== undefined && path.index !== "unchanged";
  const unstaged = path.worktree !== "unchanged";
  const conflict = path.conflict || path.index === "unmerged" || path.worktree === "unmerged";
  const nameRole: StatusTextRole = conflict
    ? "conflict"
    : staged && unstaged
      ? "text"
      : staged
        ? "staged"
        : unstaged
          ? "unstaged"
          : "text";
  const primary: StatusTextSpan[] = [];
  if (path.previousPath)
    primary.push({ text: `${statusDisplayText(path.previousPath)} -> `, role: "muted" });
  primary.push({ text: statusDisplayText(path.path), role: nameRole });
  const secondary: StatusTextSpan[] = [];
  const fact = (text: string, role: StatusTextRole) => {
    if (secondary.length) secondary.push({ text: " · ", role: "muted" });
    secondary.push({ text, role });
  };
  if (staged)
    fact(`${PATH_LABELS[path.index!]} (staged)`, path.index === "unmerged" ? "conflict" : "staged");
  if (unstaged && (path.worktree !== "untracked" || staged || conflict))
    fact(
      `${PATH_LABELS[path.worktree]}${path.index === undefined ? "" : " (unstaged)"}`,
      path.worktree === "unmerged" ? "conflict" : "unstaged",
    );
  if (conflict) fact("conflict", "conflict");
  if (path.submodule)
    fact(
      `submodule${path.submodule.commitChanged ? " commit changed" : ""}${path.submodule.trackedChanges ? " tracked changes" : ""}${path.submodule.untrackedChanges ? " untracked changes" : ""}`,
      "muted",
    );
  return { primary, secondary };
}

/** Format sibling availability without interpreting an unavailable count as clean. */
export function formatStatusWorktree(row: ExtensionVcsStatusWorktreeSummary): StatusTextFacts {
  const status = row.status;
  const state =
    status.state === "ready"
      ? `${status.changedPathCount ? `${status.changedPathCount} changed paths` : "clean"}${status.conflictCount ? ` · ${status.conflictCount} conflicts` : ""}${status.operations.state === "ready" ? status.operations.value.map((value) => ` · ${value}`).join("") : " · operation state unavailable"}`
      : `${status.state}: ${statusDisplayText(status.message)}`;
  return {
    primary: [
      {
        text: statusDisplayText(row.branch ?? (row.bare ? "bare" : "detached")),
        role: row.inspectable ? "accent" : "text",
      },
      { text: `  ${statusDisplayText(row.worktree.path)}`, role: "muted" },
    ],
    secondary: [
      {
        text: `${state}${row.locked !== undefined ? ` · locked${row.locked ? `: ${statusDisplayText(row.locked)}` : ""}` : ""}${row.prunable !== undefined ? " · prunable" : ""}`,
        role: row.status.state === "error" ? "conflict" : "muted",
      },
    ],
  };
}

/** Project the same snapshot used by JSON and the interactive surface, without an inspector. */
export function projectStaticStatus(
  snapshot: ExtensionVcsStatusSnapshot,
  {
    theme,
    color = false,
  }: {
    theme?: AppTheme;
    color?: boolean;
  } = {},
) {
  const paint = (text: string, role: StatusTextRole) =>
    color && theme ? `${foreground(statusTextColor(theme, role))}${text}\x1b[0m` : text;
  const paintSpans = (spans: StatusTextSpan[]) =>
    spans.map((span) => paint(span.text, span.role)).join("");
  const groups = groupStatusPaths(snapshot.paths);
  const changedPathCount = groups.reduce((count, group) => count + group.paths.length, 0);
  const head = snapshot.head;
  const label =
    head.kind === "detached"
      ? `detached ${head.revisionId.slice(0, 12)}`
      : `${head.name}${head.kind === "unborn" ? " (unborn)" : ""}`;
  const lines = [
    paint(statusDisplayText(snapshot.worktree.path), "accent"),
    statusDisplayText(label),
    formatStatusUpstream(snapshot.upstream),
  ];
  if (snapshot.operations.state === "ready") {
    if (snapshot.operations.value.length)
      lines.push(`Operation: ${snapshot.operations.value.join(" · ")}`);
  } else
    lines.push(
      `Operation state ${snapshot.operations.state}: ${statusDisplayText(snapshot.operations.state === "error" ? snapshot.operations.message : snapshot.operations.reason)}`,
    );
  const conflicts = snapshot.paths.filter((path) => path.conflict).length;
  if (conflicts) lines.push(`${conflicts} conflicted path${conflicts === 1 ? "" : "s"}`);
  lines.push(
    "",
    changedPathCount
      ? `${changedPathCount} changed path${changedPathCount === 1 ? "" : "s"}`
      : "Clean working tree",
  );
  for (const group of groups) {
    lines.push(paint(`${group.title} (${group.paths.length})`, "text"));
    for (const path of group.paths) {
      const { primary, secondary } = formatStatusPath(path);
      lines.push(`  ${paintSpans(primary)}${secondary.length ? `  ${paintSpans(secondary)}` : ""}`);
    }
  }
  lines.push("", paint(STATUS_WORKTREES_HEADING, "accent"));
  if (snapshot.siblings.state === "ready") {
    if (!snapshot.siblings.value.worktrees.length) lines.push("  None");
    for (const row of snapshot.siblings.value.worktrees) {
      const { primary, secondary } = formatStatusWorktree(row);
      lines.push(`  ${paintSpans(primary)}  ${paintSpans(secondary)}`);
    }
    if (snapshot.siblings.value.truncated)
      lines.push("  Additional worktrees omitted (scan limit).");
  } else if (snapshot.siblings.state === "loading") lines.push("  Loading");
  else
    lines.push(
      `  ${snapshot.siblings.state}: ${statusDisplayText(snapshot.siblings.state === "error" ? snapshot.siblings.message : snapshot.siblings.reason)}`,
    );
  return `${lines.join("\n")}\n`;
}
