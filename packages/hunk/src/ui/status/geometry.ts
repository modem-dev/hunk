import type { StatusState } from "./controller";
import { groupStatusPaths, STATUS_PATH_GROUP_LIMIT, type StatusPathGroupId } from "./pathGroups";
import {
  formatStatusPath,
  formatStatusWorktree,
  statusDisplayText,
  statusPlainText,
  STATUS_WORKTREES_HEADING,
  type StatusTextFacts,
  type StatusTextSpan,
} from "./staticProjection";
import { wrapTextByWidth, measureTextWidth } from "../lib/text";

export interface StatusRow {
  id: string;
  lines: StatusTextSpan[][];
  kind: "path" | "worktree" | "heading" | "toggle";
  group?: StatusPathGroupId;
  disabled?: boolean;
}

/** Wrap styled text without losing path whitespace or the role of each status fact. */
export function wrapStatusSpans(spans: StatusTextSpan[], width: number): StatusTextSpan[][] {
  const lines: StatusTextSpan[][] = [[]];
  let used = 0;
  for (const span of spans) {
    for (const chunk of wrapTextByWidth(span.text, width, width - used, used > 0)) {
      if (chunk.startsNewLine) {
        lines.push([]);
        used = 0;
      }
      lines[lines.length - 1]!.push({ text: chunk.text, role: span.role });
      used += chunk.width;
    }
  }
  return lines;
}

/** Stack secondary facts when needed and preserve terminal-cell widths without an inspector. */
export function projectStatusRows(state: StatusState, width: number): StatusRow[] {
  const available = Math.max(1, width - 2);
  const heading = (text: string, role: StatusTextSpan["role"] = "muted") =>
    wrapStatusSpans([{ text, role }], available);
  const facts = ({ primary, secondary }: StatusTextFacts, indent = false) => {
    const padding = indent ? " ".repeat(Math.min(2, available - 1)) : "";
    const factWidth = available - padding.length;
    const wrap = (spans: StatusTextSpan[]) => wrapStatusSpans(spans, factWidth);
    const indented = (lines: StatusTextSpan[][]) =>
      lines.map((line) => (padding ? [{ text: padding, role: "muted" as const }, ...line] : line));
    if (!secondary.length) return indented(wrap(primary));
    const combined: StatusTextSpan[] = [...primary, { text: "  ", role: "muted" }, ...secondary];
    return indented(
      measureTextWidth(statusPlainText(combined)) <= factWidth
        ? [combined]
        : [...wrap(primary), ...wrap(secondary)],
    );
  };
  const snapshot = state.snapshot;
  const groups = groupStatusPaths(snapshot.paths);
  const changedPathCount = groups.reduce((count, group) => count + group.paths.length, 0);
  const rows: StatusRow[] = [
    {
      id: "changes",
      kind: "heading",
      lines: [
        ...heading(
          changedPathCount
            ? `${changedPathCount} changed path${changedPathCount === 1 ? "" : "s"}`
            : "Clean working tree",
          "text",
        ),
      ],
    },
  ];
  for (const group of groups) {
    rows.push({
      id: `group:${group.id}`,
      kind: "heading",
      lines: heading(`${group.title} (${group.paths.length})`, "text"),
    });
    const expanded = state.expandedPathGroups[group.id];
    for (const path of expanded ? group.paths : group.paths.slice(0, STATUS_PATH_GROUP_LIMIT))
      rows.push({
        id: `path:${path.path}`,
        kind: "path",
        lines: facts(formatStatusPath(path), true),
      });
    if (group.paths.length > STATUS_PATH_GROUP_LIMIT)
      rows.push({
        id: `toggle:${group.id}`,
        kind: "toggle",
        group: group.id,
        lines: facts(
          {
            primary: [
              {
                text: expanded
                  ? "Show fewer"
                  : `and ${group.paths.length - STATUS_PATH_GROUP_LIMIT} more file${group.paths.length - STATUS_PATH_GROUP_LIMIT === 1 ? "" : "s"}`,
                role: "accent",
              },
            ],
            secondary: [],
          },
          true,
        ),
      });
  }
  rows.push({
    id: "worktrees",
    kind: "heading",
    lines: [[], ...heading(STATUS_WORKTREES_HEADING, "accent")],
  });
  const siblings = snapshot.siblings;
  if (siblings.state === "ready") {
    const visible = state.expandedWorktrees
      ? siblings.value.worktrees
      : siblings.value.worktrees.slice(0, 4);
    for (const sibling of visible) {
      rows.push({
        id: `worktree:${sibling.worktree.id}`,
        kind: "worktree",
        lines: facts(formatStatusWorktree(sibling)),
        disabled: !sibling.inspectable,
      });
    }
    if (!visible.length) rows.push({ id: "none", kind: "heading", lines: heading("None") });
    if (visible.length < siblings.value.worktrees.length || siblings.value.truncated)
      rows.push({
        id: "more",
        kind: "heading",
        lines: heading(
          `${siblings.value.worktrees.length - visible.length} more · W expand${siblings.value.truncated ? " · scan limit reached" : ""}`,
        ),
      });
  } else
    rows.push({
      id: "siblings-state",
      kind: "heading",
      lines: heading(
        siblings.state === "loading"
          ? "Loading worktrees…"
          : statusDisplayText(siblings.state === "error" ? siblings.message : siblings.reason),
      ),
    });
  return rows;
}

/** Scroll oversized rows before moving selection, so every wrapped fact remains reachable. */
export function moveStatusFocus(
  rows: StatusRow[],
  selected: string | null,
  requestedTop: number,
  height: number,
  delta: number,
) {
  const viewport = planStatusViewport(rows, selected, requestedTop, height);
  let start = 0;
  for (const row of rows) {
    if (row.id === selected) {
      const lastTop = start + row.lines.length - height;
      if (
        row.lines.length > height &&
        (delta > 0 ? viewport.top < lastTop : viewport.top > start)
      ) {
        return { selected, top: Math.max(start, Math.min(lastTop, viewport.top + delta)) };
      }
      break;
    }
    start += row.lines.length;
  }
  const navigable = rows.filter((row) => row.kind !== "heading");
  const index = navigable.findIndex((row) => row.id === selected);
  const next = navigable[Math.max(0, Math.min(navigable.length - 1, index + delta))]?.id ?? null;
  return { selected: next, top: planStatusViewport(rows, next, viewport.top, height).top };
}

/** Keep the focused row visible through resize while retaining the user's requested scroll. */
export function planStatusViewport(
  rows: StatusRow[],
  selected: string | null,
  requestedTop: number,
  height: number,
) {
  const starts: number[] = [];
  let total = 0;
  for (const row of rows) {
    starts.push(total);
    total += row.lines.length;
  }
  let top = Math.max(0, Math.min(requestedTop, total - height));
  const focus = rows.findIndex((row) => row.id === selected);
  if (focus >= 0) {
    const start = starts[focus]!;
    const end = start + rows[focus]!.lines.length;
    if (end - start > height) top = Math.max(start, Math.min(top, end - height));
    else if (start < top) top = start;
    else if (end > top + height) top = end - height;
  }
  return {
    top,
    lines: rows
      .flatMap((row, index) =>
        row.lines.map((spans, line) => ({
          row,
          spans,
          text: statusPlainText(spans),
          offset: starts[index]! + line,
        })),
      )
      .filter((line) => line.offset >= top && line.offset < top + height),
  };
}
