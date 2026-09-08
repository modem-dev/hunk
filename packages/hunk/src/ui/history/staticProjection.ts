import type { HistoryGraphRow } from "../../core/history/types";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../../lib/terminalText";
import { fitText, measureTextWidth } from "../lib/text";
import { resolveTheme, type AppTheme } from "../themes";

export interface HistoryProjectionOptions {
  ascii: boolean;
  color: boolean;
  theme?: AppTheme;
  /** Omit width to emit complete unpadded logical rows for pipes and files. */
  width?: number;
}

/** Resolve history colors from the same built-in and custom themes as review. */
export function resolveHistoryTheme(
  themeId: string | undefined,
  customThemes: readonly NamedCustomThemeConfig[] = [],
) {
  return resolveTheme(themeId, null, customThemes);
}

/** Convert a validated #rrggbb theme color to a terminal SGR foreground. */
export function foreground(color: string) {
  const [red, green, blue] = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16),
  );
  return `\x1b[38;2;${red};${green};${blue}m`;
}

/** Render one symbolic lane prefix without consulting commit metadata or refs. */
export function renderHistoryGraph(row: HistoryGraphRow, ascii: boolean) {
  const vertical = ascii ? "|" : "│";
  const node = ascii ? "*" : "●";
  if (row.parentLanes.length <= 1) {
    return row.cells
      .map((cell) => (cell.kind === "node" ? node : cell.kind === "vertical" ? vertical : " "))
      .join(" ")
      .trimEnd();
  }

  const laneCount = Math.max(row.lanesBefore.length, row.lanesAfter.length);
  const characters = Array.from({ length: Math.max(1, laneCount * 2 - 1) }, () => " ");
  for (let lane = 0; lane < row.lanesAfter.length; lane += 1) characters[lane * 2] = vertical;
  characters[row.lane * 2] = node;
  for (const parentLane of row.parentLanes.slice(1)) {
    const from = Math.min(row.lane * 2, parentLane * 2);
    const to = Math.max(row.lane * 2, parentLane * 2);
    for (let index = from + 1; index < to; index += 1) {
      if (index % 2 === 1) characters[index] = ascii ? "-" : "─";
      else if (characters[index] === vertical) characters[index] = ascii ? "+" : "┼";
    }
    characters[parentLane * 2] = ascii ? "+" : parentLane > row.lane ? "┬" : "┴";
  }
  return characters.join("").trimEnd();
}

/** Render active lanes after a commit for its metadata and message continuation lines. */
export function renderHistoryContinuation(row: HistoryGraphRow, ascii: boolean) {
  const vertical = ascii ? "|" : "│";
  return row.lanesAfter
    .map(() => vertical)
    .join(" ")
    .trimEnd();
}

/** Render a lane-collapse transition that makes converging ancestry explicit. */
export function renderHistoryConvergence(row: HistoryGraphRow, ascii: boolean) {
  if (row.convergences.length === 0) return "";
  const width = Math.max(row.lanesBefore.length, row.lanesAfter.length) * 2 - 1;
  const chars = Array.from({ length: Math.max(1, width) }, () => " ");
  for (let lane = 0; lane < row.lanesAfter.length; lane += 1) chars[lane * 2] = ascii ? "|" : "│";
  for (const { from, to } of row.convergences) {
    const start = Math.min(from, to) * 2 + 1;
    const end = Math.max(from, to) * 2 - 1;
    for (let index = start; index <= end; index += 1) {
      chars[index] = from > to ? (ascii ? "/" : "╯") : ascii ? "\\" : "╰";
    }
  }
  return chars.join("").trimEnd();
}

/** Format typed refs in familiar Git decoration vocabulary without inferring topology. */
export function formatHistoryDecorations(row: HistoryGraphRow) {
  const values = row.commit.decorations
    .map((entry) => ({
      kind: entry.kind,
      label: sanitizeTerminalLine(entry.label).replaceAll("\t", " "),
      ...(entry.kind === "head" && entry.attachedLocalBranch
        ? {
            attachedLocalBranch: sanitizeTerminalLine(entry.attachedLocalBranch).replaceAll(
              "\t",
              " ",
            ),
          }
        : {}),
    }))
    .filter((entry) => entry.label);
  const headIndex = values.findIndex((entry) => entry.kind === "head");
  const head = headIndex >= 0 ? values[headIndex] : undefined;
  const attachedBranch = head?.attachedLocalBranch ?? "";
  const branchIndex = attachedBranch
    ? values.findIndex((entry) => entry.kind === "local-branch" && entry.label === attachedBranch)
    : -1;
  const labels: string[] = [];
  if (head) labels.push(attachedBranch ? `${head.label} -> ${attachedBranch}` : head.label);
  for (let index = 0; index < values.length; index += 1) {
    if (index === headIndex || index === branchIndex) continue;
    const entry = values[index]!;
    labels.push(entry.kind === "tag" ? `tag: ${entry.label}` : entry.label);
  }
  return labels.length ? ` (${labels.join(", ")})` : "";
}

/** Clamp a logical terminal line before applying styling. */
function clampLine(text: string, width: number | undefined) {
  return width === undefined ? text : fitText(text, Math.max(1, width), "…");
}

/** Apply a semantic theme color only when styling is enabled. */
function styled(text: string, color: string, enabled: boolean) {
  return enabled ? `${foreground(color)}${text}\x1b[0m` : text;
}

/** Color graph cells with a stable lane-index palette derived from the active Hunk theme. */
function styledGraph(text: string, theme: AppTheme) {
  const palette = [
    theme.accent,
    theme.addedSignColor,
    theme.removedSignColor,
    theme.fileRenamed,
    theme.noteBorder,
  ];
  return Array.from(text, (character, index) =>
    character === " "
      ? character
      : styled(character, palette[Math.floor(index / 2) % palette.length]!, true),
  ).join("");
}

/** Return the zero-based display-cell bounds occupied by a compact row's commit id. */
export function getHistoryCommitIdBounds(row: HistoryGraphRow, ascii = false) {
  const graphPrefix = `${renderHistoryGraph(row, ascii)}  `;
  const displayId = sanitizeTerminalLine(row.commit.displayId).replaceAll("\t", " ");
  const start = measureTextWidth(graphPrefix);
  return { start, end: start + measureTextWidth(displayId) };
}

/** Render one safe compact history row from symbolic topology and normalized metadata. */
export function projectHistoryRow(row: HistoryGraphRow, options: HistoryProjectionOptions) {
  const theme = options.theme ?? resolveHistoryTheme(undefined);
  const graph = renderHistoryGraph(row, options.ascii);
  const displayId = sanitizeTerminalLine(row.commit.displayId).replaceAll("\t", " ");
  const subject = sanitizeTerminalLine(row.commit.subject).replaceAll("\t", " ");
  const refs = formatHistoryDecorations(row);
  const author = sanitizeTerminalLine(row.commit.authorName).replaceAll("\t", " ");
  const date = row.commit.authoredAt.slice(0, 10);
  const graphPrefix = `${graph}  `;
  const hashPrefix = `${displayId}  `;
  let suffix = `${subject}${refs}  ${author}  ${date}`;
  if (options.width !== undefined) {
    const available = Math.max(
      1,
      options.width - measureTextWidth(graphPrefix) - measureTextWidth(hashPrefix),
    );
    const candidates = [
      `${subject}${refs}  ${author}  ${date}`,
      `${subject}${refs}  ${date}`,
      `${subject}${refs}`,
      subject,
    ];
    suffix =
      candidates.find((candidate) => measureTextWidth(candidate) <= available) ??
      fitText(subject, available, "…");
  }
  const plain = clampLine(`${graphPrefix}${hashPrefix}${suffix}`, options.width);
  if (!options.color) return plain;
  const graphText = plain.slice(0, graphPrefix.length);
  const hashText = plain.slice(graphPrefix.length, graphPrefix.length + hashPrefix.length);
  return `${styledGraph(graphText, theme)}${styled(hashText, theme.accent, true)}${plain.slice(graphPrefix.length + hashPrefix.length)}`;
}

/** Render a themed standalone lane-collapse line for compact static output. */
export function projectHistoryConvergence(row: HistoryGraphRow, options: HistoryProjectionOptions) {
  const plain = clampLine(renderHistoryConvergence(row, options.ascii), options.width);
  if (!plain || !options.color) return plain;
  const theme = options.theme ?? resolveHistoryTheme(undefined);
  return styledGraph(plain, theme);
}

/** Render a complete Git-like medium record, including body and graph continuation. */
export function projectHistoryRecord(row: HistoryGraphRow, options: HistoryProjectionOptions) {
  const theme = options.theme ?? resolveHistoryTheme(undefined);
  const graph = renderHistoryGraph(row, options.ascii);
  const continuation = renderHistoryContinuation(row, options.ascii);
  const fullId = sanitizeTerminalLine(row.commit.revisionId);
  const refs = formatHistoryDecorations(row);
  const authorName = sanitizeTerminalLine(row.commit.authorName).replaceAll("\t", " ");
  const authorEmail = row.commit.authorEmail
    ? ` <${sanitizeTerminalLine(row.commit.authorEmail).replaceAll("\t", " ")}>`
    : "";
  const date = sanitizeTerminalLine(row.commit.authoredAt).replace("T", " ");
  const subject = sanitizeTerminalLine(row.commit.subject).replaceAll("\t", " ");
  const body = row.commit.body
    ? sanitizeTerminalText(row.commit.body, { preserveNewlines: true, preserveTabs: false }).split(
        "\n",
      )
    : [];
  while (body.at(-1) === "") body.pop();
  const prefix = (laneText: string) => (laneText ? `${laneText}  ` : "   ");
  const plainLines = [
    `${prefix(graph)}commit ${fullId}${refs}`,
    `${prefix(continuation)}Author: ${authorName}${authorEmail}`,
    `${prefix(continuation)}Date:   ${date}`,
    prefix(continuation).trimEnd(),
    `${prefix(continuation)}    ${subject}`,
    ...(body.length
      ? [
          prefix(continuation).trimEnd(),
          ...body.map((line) => `${prefix(continuation)}    ${line}`),
        ]
      : []),
  ];
  const convergence = renderHistoryConvergence(row, options.ascii);
  if (convergence) plainLines.push(convergence);
  plainLines.push(prefix(continuation).trimEnd());
  const fitted = plainLines.map((line) => clampLine(line, options.width));
  if (!options.color) return fitted;
  return fitted.map((line, index) => {
    if (!line) return line;
    const laneWidth = index === 0 ? prefix(graph).length : prefix(continuation).length;
    const lane = line.slice(0, laneWidth);
    const rest = line.slice(laneWidth);
    if (index === 0 && rest.startsWith("commit ")) {
      const hashStart = "commit ".length;
      const hashEnd = Math.min(rest.length, hashStart + fullId.length);
      return `${styledGraph(lane, theme)}${rest.slice(0, hashStart)}${styled(rest.slice(hashStart, hashEnd), theme.accent, true)}${styled(rest.slice(hashEnd), theme.addedSignColor, true)}`;
    }
    const color = index >= 4 ? theme.text : theme.muted;
    return `${styledGraph(lane, theme)}${styled(rest, color, true)}`;
  });
}

/** Resolve color according to explicit CLI precedence and conventional terminal signals. */
export function resolveHistoryColor({
  mode,
  stdoutIsTTY,
  env,
}: {
  mode: "auto" | "always" | "never";
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return stdoutIsTTY && env.TERM !== "dumb" && !("NO_COLOR" in env);
}
