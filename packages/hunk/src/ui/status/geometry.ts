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

type StatusContentState = Pick<
  StatusState,
  "snapshot" | "expandedPathGroups" | "expandedWorktrees"
>;

/** Stack secondary facts when needed and preserve terminal-cell widths without an inspector. */
export function projectStatusRows(state: StatusContentState, width: number): StatusRow[] {
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
  const changedPathCount = snapshot.changedPathCount;
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

export interface StatusGeometry {
  rows: StatusRow[];
  starts: number[];
  total: number;
  byId: Map<string, number>;
  navigable: StatusRow[];
  navigationIndex: Map<string, number>;
}

/** Index measured rows once; selection and scrolling never remeasure content. */
export function measureStatusRows(rows: StatusRow[]): StatusGeometry {
  const geometry: StatusGeometry = {
    rows,
    starts: [],
    total: 0,
    byId: new Map(),
    navigable: [],
    navigationIndex: new Map(),
  };
  for (const [index, row] of rows.entries()) {
    geometry.starts.push(geometry.total);
    geometry.total += row.lines.length;
    geometry.byId.set(row.id, index);
    if (row.kind !== "heading") {
      geometry.navigationIndex.set(row.id, geometry.navigable.length);
      geometry.navigable.push(row);
    }
  }
  return geometry;
}

/** Cache content measurement independently of focus, notices, loading and snapshot metadata. */
export function createStatusGeometryCache(project = projectStatusRows) {
  let previous:
    | {
        paths: StatusState["snapshot"]["paths"];
        changedPathCount: number;
        siblings: StatusState["snapshot"]["siblings"];
        tracked: boolean;
        untracked: boolean;
        worktrees: boolean;
        width: number;
        geometry: StatusGeometry;
      }
    | undefined;

  return {
    get(state: StatusState, width: number): StatusGeometry {
      const { paths, changedPathCount, siblings } = state.snapshot;
      const { tracked, untracked } = state.expandedPathGroups;
      if (
        previous &&
        previous.paths === paths &&
        previous.changedPathCount === changedPathCount &&
        previous.siblings === siblings &&
        previous.tracked === tracked &&
        previous.untracked === untracked &&
        previous.worktrees === state.expandedWorktrees &&
        previous.width === width
      )
        return previous.geometry;

      const geometry = measureStatusRows(project(state, width));
      previous = {
        paths,
        changedPathCount,
        siblings,
        tracked,
        untracked,
        worktrees: state.expandedWorktrees,
        width,
        geometry,
      };
      return geometry;
    },
  };
}

/** Keep focus visible without materializing any viewport entries. */
function statusViewportTop(
  geometry: StatusGeometry,
  selected: string | null,
  requestedTop: number,
  height: number,
) {
  let top = Math.max(0, Math.min(requestedTop, geometry.total - height));
  const focus = selected === null ? undefined : geometry.byId.get(selected);
  if (focus !== undefined) {
    const start = geometry.starts[focus]!;
    const end = start + geometry.rows[focus]!.lines.length;
    if (end - start > height) top = Math.max(start, Math.min(top, end - height));
    else if (start < top) top = start;
    else if (end > top + height) top = end - height;
  }
  return top;
}

/** Scroll oversized rows before moving selection, so every wrapped fact remains reachable. */
export function moveStatusFocus(
  geometry: StatusGeometry,
  selected: string | null,
  requestedTop: number,
  height: number,
  delta: number,
) {
  const top = statusViewportTop(geometry, selected, requestedTop, height);
  const focus = selected === null ? undefined : geometry.byId.get(selected);
  if (focus !== undefined) {
    const row = geometry.rows[focus]!;
    const start = geometry.starts[focus]!;
    const lastTop = start + row.lines.length - height;
    if (row.lines.length > height && (delta > 0 ? top < lastTop : top > start))
      return { selected, top: Math.max(start, Math.min(lastTop, top + delta)) };
  }

  const index = selected === null ? -1 : (geometry.navigationIndex.get(selected) ?? -1);
  const next =
    geometry.navigable[Math.max(0, Math.min(geometry.navigable.length - 1, index + delta))]?.id ??
    null;
  return { selected: next, top: statusViewportTop(geometry, next, top, height) };
}

/** Materialize only intersecting rows, seeking their measured offsets without flattening the stream. */
export function planStatusViewport(
  geometry: StatusGeometry,
  selected: string | null,
  requestedTop: number,
  height: number,
) {
  const top = statusViewportTop(geometry, selected, requestedTop, height);
  const { rows, starts } = geometry;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! + rows[middle]!.lines.length <= top) low = middle + 1;
    else high = middle;
  }

  const lines: {
    row: StatusRow;
    spans: StatusTextSpan[];
    text: string;
    offset: number;
  }[] = [];
  for (let index = low; index < rows.length && starts[index]! < top + height; index++) {
    const row = rows[index]!;
    const start = starts[index]!;
    const end = Math.min(row.lines.length, top + height - start);
    for (let line = Math.max(0, top - start); line < end; line++) {
      const spans = row.lines[line]!;
      lines.push({ row, spans, text: statusPlainText(spans), offset: start + line });
    }
  }
  return { top, lines };
}
