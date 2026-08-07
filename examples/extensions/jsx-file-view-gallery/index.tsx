import type { ReactNode } from "react";
import type {
  ExtensionDiffFile,
  ExtensionFileChangeRange,
  ExtensionFileViewInput,
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSourceRange,
  ExtensionFactory,
} from "hunkdiff/extension";

const SOURCE_LIMIT = 200_000;

type RowPainter = (props: ExtensionFileViewRowComponentProps) => ReactNode;
type DependencyGroup = "dependencies" | "devDependencies";

interface CssToken {
  name: string;
  value: string;
  line: number;
}

interface DependencyToken {
  group: DependencyGroup;
  name: string;
  value: string;
  line: number;
}

/** Count inclusive source lines represented by one public change range. */
function changeSize(change: ExtensionFileChangeRange) {
  return change.range[1] - change.range[0] + 1;
}

/** Omit Pierre's `[0, 0]` sentinel for the nonexistent side of added/deleted files. */
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

/** Keep painter-authored labels inside their fixed terminal rectangle. */
function clipLabel(text: string, width: number) {
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** Draw a bounded proportional meter without changing declared row geometry. */
export function impactMeter(value: number, total: number, width: number) {
  const filled = value === 0 || total === 0 ? 0 : Math.max(1, Math.round((value / total) * width));
  return `${"█".repeat(Math.min(width, filled))}${"░".repeat(Math.max(0, width - filled))}`;
}

/** Paint one responsive hunk-impact card from data captured during layout. */
function impactPainter(
  position: number,
  header: string,
  added: number,
  removed: number,
): RowPainter {
  return function ImpactCard({ width, height, selected, theme }) {
    const meterWidth = Math.max(4, Math.min(16, Math.floor((width - 20) / 2)));
    const total = Math.max(1, added + removed);
    return (
      <box style={{ width, height, flexDirection: "column" }}>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text
            content={`${selected ? "▶" : "◇"} CHANGE ${String(position + 1).padStart(2, "0")}`}
            style={{ fg: selected ? theme.accent : theme.accentMuted }}
          />
          <text content={`   +${added} / -${removed}`} style={{ fg: theme.text }} />
        </box>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text
            content={`  + ${impactMeter(added, total, meterWidth)}`}
            style={{ fg: theme.fileNew }}
          />
          <text
            content={`   - ${impactMeter(removed, total, meterWidth)}`}
            style={{ fg: theme.fileDeleted }}
          />
        </box>
        <text
          content={`  ${clipLabel(header, Math.max(1, width - 2))}`}
          style={{ fg: theme.muted }}
        />
      </box>
    );
  };
}

/** Build a general-purpose visual atlas with one fixed card per real diff hunk. */
export function createChangeAtlasLayout(
  input: ExtensionFileViewInput,
): ExtensionFileViewLayout | null {
  const hunks = input.file.hunks ?? [];
  if (hunks.length === 0) return null;

  const rows: ExtensionFileViewRow[] = hunks.map((hunk, position) => {
    const changes = input.changes.filter((change) => change.hunkIndex === position);
    const added = changes
      .filter((change) => change.kind === "added")
      .reduce((total, change) => total + changeSize(change), 0);
    const removed = changes
      .filter((change) => change.kind === "removed")
      .reduce((total, change) => total + changeSize(change), 0);
    return {
      id: `impact:${position}`,
      spans: [
        {
          text: `Change ${position + 1}: +${added} -${removed} · ${hunk.header}`,
          tone: "accent",
        },
      ],
      sourceRanges: hunkSourceRanges(hunk),
      component: {
        height: 3,
        render: impactPainter(position, hunk.header, added, removed),
      },
    };
  });

  return {
    rows,
    hunkRows: hunks.map((_, position) => ({ startRow: position, endRow: position })),
  };
}

/** Paint a neutral fixed-height placeholder for a hunk with no demo-specific semantic match. */
function summaryPainter(title: string, detail: string): RowPainter {
  return function SummaryCard({ width, height, selected, theme }) {
    return (
      <box style={{ width, height, flexDirection: "column" }}>
        <text
          content={`${selected ? "▶" : "◇"} ${clipLabel(title, Math.max(1, width - 2))}`}
          style={{ fg: selected ? theme.accent : theme.accentMuted }}
        />
        <text
          content={`  ${clipLabel(detail, Math.max(1, width - 2))}`}
          style={{ fg: theme.muted }}
        />
      </box>
    );
  };
}

/** Parse conservative hexadecimal CSS custom-property declarations with source lines. */
function parseCssTokens(source: string): CssToken[] {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*(--[\w-]+)\s*:\s*(#(?:[\da-fA-F]{6}|[\da-fA-F]{3}))\s*;/.exec(line);
    return match ? [{ name: match[1]!, value: match[2]!, line: index + 1 }] : [];
  });
}

/** Test whether a source token falls inside one of a hunk's side-specific ranges. */
function tokenIsChanged(
  line: number,
  kind: ExtensionFileChangeRange["kind"],
  position: number,
  changes: readonly ExtensionFileChangeRange[],
) {
  return changes.some(
    (change) =>
      change.hunkIndex === position &&
      change.kind === kind &&
      change.range[0] <= line &&
      line <= change.range[1],
  );
}

/** Choose readable foreground text for a hexadecimal swatch. */
function swatchForeground(color: string) {
  const raw = color.slice(1);
  const normalized = raw.length === 3 ? raw.replace(/(.)/g, "$1$1") : raw.slice(0, 6);
  const value = Number.parseInt(normalized, 16);
  if (!Number.isFinite(value)) return "white";
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "black" : "white";
}

/** Paint one old/new terminal color swatch without claiming source geometry. */
function palettePainter(
  name: string,
  oldValue: string | null,
  newValue: string | null,
): RowPainter {
  return function PaletteSwatch({ width, height, selected, theme }) {
    const oldColor = oldValue ?? "#303030";
    const newColor = newValue ?? "#303030";
    return (
      <box style={{ width, height, flexDirection: "column" }}>
        <text
          content={`${selected ? "▶" : " "} ${clipLabel(name, Math.max(1, width - 2))}`}
          style={{ fg: selected ? theme.accent : theme.accentMuted }}
        />
        <box style={{ height: 1, flexDirection: "row" }}>
          <box style={{ width: 18, height: 1, backgroundColor: oldColor }}>
            <text
              content={` OLD ${oldValue ?? "missing"}`}
              style={{ fg: swatchForeground(oldColor) }}
            />
          </box>
          <text content="  →  " />
          <box style={{ width: 18, height: 1, backgroundColor: newColor }}>
            <text
              content={` NEW ${newValue ?? "missing"}`}
              style={{ fg: swatchForeground(newColor) }}
            />
          </box>
        </box>
      </box>
    );
  };
}

/** Build semantic old/new swatches for changed hexadecimal CSS variables. */
export async function createCssPaletteLayout(
  input: ExtensionFileViewInput,
): Promise<ExtensionFileViewLayout | null> {
  const hunks = input.file.hunks ?? [];
  const [oldSource, newSource] = await Promise.all([
    input.readDocument("old"),
    input.readDocument("new"),
  ]);
  if (
    hunks.length === 0 ||
    oldSource === null ||
    newSource === null ||
    oldSource.length > SOURCE_LIMIT ||
    newSource.length > SOURCE_LIMIT ||
    input.signal.aborted
  ) {
    return null;
  }

  const oldTokens = parseCssTokens(oldSource);
  const newTokens = parseCssTokens(newSource);
  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];
  let semanticRowCount = 0;

  for (const [position, hunk] of hunks.entries()) {
    const startRow = rows.length;
    const oldChanged = oldTokens.filter((token) =>
      tokenIsChanged(token.line, "removed", position, input.changes),
    );
    const newChanged = newTokens.filter((token) =>
      tokenIsChanged(token.line, "added", position, input.changes),
    );
    const names = [...new Set([...oldChanged, ...newChanged].map((token) => token.name))];
    const hasAmbiguousDuplicate = names.some(
      (name) =>
        oldChanged.filter((token) => token.name === name).length > 1 ||
        newChanged.filter((token) => token.name === name).length > 1,
    );
    if (hasAmbiguousDuplicate) return null;

    for (const [tokenPosition, name] of names.entries()) {
      const oldToken = oldChanged.find((token) => token.name === name);
      const newToken = newChanged.find((token) => token.name === name);
      const oldValue = oldToken?.value ?? null;
      const newValue = newToken?.value ?? null;
      semanticRowCount += 1;
      rows.push({
        id: `palette:${position}:${tokenPosition}:${name}`,
        spans: [
          {
            text: `${name}: ${oldValue ?? "missing"} → ${newValue ?? "missing"}`,
            tone: "syntax",
          },
        ],
        sourceRanges: [
          ...(oldToken
            ? [{ side: "old" as const, range: [oldToken.line, oldToken.line] as const }]
            : []),
          ...(newToken
            ? [{ side: "new" as const, range: [newToken.line, newToken.line] as const }]
            : []),
        ],
        component: { height: 2, render: palettePainter(name, oldValue, newValue) },
      });
    }

    if (rows.length === startRow) {
      rows.push({
        id: `palette:${position}:summary`,
        spans: [{ text: `Hunk ${position + 1}: no changed hexadecimal variables`, tone: "muted" }],
        sourceRanges: hunkSourceRanges(hunk),
        component: {
          height: 2,
          render: summaryPainter(`PALETTE HUNK ${position + 1}`, hunk.header),
        },
      });
    }
    hunkRows.push({ startRow, endRow: rows.length - 1 });
  }

  return semanticRowCount > 0 ? { rows, hunkRows } : null;
}

/** Parse dependency entries conservatively after JSON syntax has already been validated. */
function parseDependencyTokens(source: string): DependencyToken[] | null {
  try {
    JSON.parse(source);
  } catch {
    return null;
  }

  const tokens: DependencyToken[] = [];
  let group: DependencyGroup | null = null;
  let sectionIndent = -1;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const section = /^(\s*)"(dependencies|devDependencies)"\s*:\s*\{\s*$/.exec(line);
    if (section) {
      group = section[2] as DependencyGroup;
      sectionIndent = section[1]!.length;
      continue;
    }
    if (group && new RegExp(`^\\s{0,${sectionIndent}}}`).test(line) && /^\s*}/.test(line)) {
      group = null;
      sectionIndent = -1;
      continue;
    }
    if (!group) continue;
    const entry = /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/.exec(line);
    if (entry) tokens.push({ group, name: entry[1]!, value: entry[2]!, line: index + 1 });
  }
  return tokens;
}

interface HighlightedVersion {
  before: string;
  changed: string;
  after: string;
}

/** Split old/new versions around the most meaningful changed semantic-version segment. */
export function versionChangeHighlights(oldValue: string | null, newValue: string | null) {
  const whole = (value: string | null): HighlightedVersion => ({
    before: "",
    changed: value ?? "",
    after: "",
  });
  if (oldValue === null) {
    return { old: { before: "∅", changed: "", after: "" }, new: whole(newValue) };
  }
  if (newValue === null) {
    return { old: whole(oldValue), new: { before: "∅", changed: "", after: "" } };
  }

  const parse = (value: string) => {
    const match = /^(\D*)(\d+)\.(\d+)\.(\d+)(.*)$/.exec(value);
    if (!match) return null;
    return {
      major: match[2]!,
      minor: match[3]!,
      patch: match[4]!,
      majorStart: match[1]!.length,
      minorStart: match[1]!.length + match[2]!.length + 1,
      patchStart: match[1]!.length + match[2]!.length + match[3]!.length + 2,
      prefix: match[1]!,
      suffix: match[5]!,
    };
  };
  const oldParsed = parse(oldValue);
  const newParsed = parse(newValue);
  if (!oldParsed || !newParsed) return { old: whole(oldValue), new: whole(newValue) };
  if (
    oldParsed.major !== newParsed.major ||
    oldParsed.prefix !== newParsed.prefix ||
    oldParsed.suffix !== newParsed.suffix
  ) {
    return { old: whole(oldValue), new: whole(newValue) };
  }

  const split = (value: string, start: number, length: number): HighlightedVersion => ({
    before: value.slice(0, start),
    changed: value.slice(start, start + length),
    after: value.slice(start + length),
  });
  if (oldParsed.minor !== newParsed.minor) {
    return {
      old: split(oldValue, oldParsed.minorStart, oldParsed.minor.length),
      new: split(newValue, newParsed.minorStart, newParsed.minor.length),
    };
  }
  if (oldParsed.patch !== newParsed.patch) {
    return {
      old: split(oldValue, oldParsed.patchStart, oldParsed.patch.length),
      new: split(newValue, newParsed.patchStart, newParsed.patch.length),
    };
  }
  return {
    old: { before: oldValue, changed: "", after: "" },
    new: { before: newValue, changed: "", after: "" },
  };
}

/** Render one version with background only behind its semantically changed segment. */
function highlightedVersion(
  parts: HighlightedVersion,
  changedColor: string,
  mutedColor: string,
  highlightBackground: string,
): ReactNode {
  return (
    <>
      <span fg={mutedColor}>{parts.before}</span>
      {parts.changed ? (
        <span fg={changedColor} bg={highlightBackground}>
          {parts.changed}
        </span>
      ) : null}
      <span fg={mutedColor}>{parts.after}</span>
    </>
  );
}

/** Paint old and new dependency versions with only their changed segments highlighted. */
function dependencyPainter(
  name: string,
  group: DependencyGroup,
  oldValue: string | null,
  newValue: string | null,
): RowPainter {
  const highlights = versionChangeHighlights(oldValue, newValue);
  return function DependencyDelta({ width, height, selected, theme }) {
    return (
      <box style={{ width, height, flexDirection: "column" }}>
        <text
          content={`${selected ? "▶" : " "} ${clipLabel(name, Math.max(1, width - group.length - 5))}  ${group}`}
          style={{ fg: selected ? theme.accent : theme.accentMuted }}
        />
        <text>
          <span fg={theme.muted}> </span>
          {highlightedVersion(highlights.old, theme.fileDeleted, theme.muted, theme.panelAlt)}
          <span fg={theme.muted}> → </span>
          {highlightedVersion(highlights.new, theme.fileNew, theme.muted, theme.panelAlt)}
        </text>
      </box>
    );
  };
}

/** Build semantic package dependency cards while preserving every parsed hunk position. */
export async function createDependencyLayout(
  input: ExtensionFileViewInput,
): Promise<ExtensionFileViewLayout | null> {
  const hunks = input.file.hunks ?? [];
  const [oldSource, newSource] = await Promise.all([
    input.readDocument("old"),
    input.readDocument("new"),
  ]);
  if (
    hunks.length === 0 ||
    !oldSource ||
    !newSource ||
    oldSource.length > SOURCE_LIMIT ||
    newSource.length > SOURCE_LIMIT ||
    input.signal.aborted
  ) {
    return null;
  }

  const oldTokens = parseDependencyTokens(oldSource);
  const newTokens = parseDependencyTokens(newSource);
  if (!oldTokens || !newTokens) return null;
  /** Refuse JSON whose duplicate keys make effective dependency values ambiguous. */
  const hasDuplicateIdentity = (tokens: readonly DependencyToken[]) => {
    const identities = tokens.map((token) => `${token.group}\0${token.name}`);
    return new Set(identities).size !== identities.length;
  };
  if (hasDuplicateIdentity(oldTokens) || hasDuplicateIdentity(newTokens)) return null;

  const rows: ExtensionFileViewRow[] = [];
  const hunkRows: { startRow: number; endRow: number }[] = [];
  let semanticRowCount = 0;
  for (const [position, hunk] of hunks.entries()) {
    const startRow = rows.length;
    const oldChanged = oldTokens.filter((token) =>
      tokenIsChanged(token.line, "removed", position, input.changes),
    );
    const newChanged = newTokens.filter((token) =>
      tokenIsChanged(token.line, "added", position, input.changes),
    );
    const identities = [
      ...new Set([...oldChanged, ...newChanged].map((token) => `${token.group}\0${token.name}`)),
    ];

    for (const [tokenPosition, identity] of identities.entries()) {
      const [group, name] = identity.split("\0") as [DependencyGroup, string];
      const oldToken = oldChanged.find((token) => token.group === group && token.name === name);
      const newToken = newChanged.find((token) => token.group === group && token.name === name);
      const oldValue = oldToken?.value ?? null;
      const newValue = newToken?.value ?? null;
      semanticRowCount += 1;
      rows.push({
        id: `dependency:${position}:${tokenPosition}:${group}:${name}`,
        spans: [
          {
            text: `${name}: ${oldValue ?? "missing"} → ${newValue ?? "missing"} (${group})`,
            tone: newValue === null ? "removed" : oldValue === null ? "added" : "accent",
          },
        ],
        sourceRanges: [
          ...(oldToken
            ? [{ side: "old" as const, range: [oldToken.line, oldToken.line] as const }]
            : []),
          ...(newToken
            ? [{ side: "new" as const, range: [newToken.line, newToken.line] as const }]
            : []),
        ],
        component: {
          height: 2,
          render: dependencyPainter(name, group, oldValue, newValue),
        },
      });
    }

    if (rows.length === startRow) {
      const title = `Package metadata hunk ${position + 1}`;
      rows.push({
        id: `dependency:${position}:summary`,
        spans: [{ text: `${title}: ${hunk.header}`, tone: "muted" }],
        sourceRanges: hunkSourceRanges(hunk),
        component: {
          height: 2,
          render: summaryPainter(title, hunk.header),
        },
      });
    }
    hunkRows.push({ startRow, endRow: rows.length - 1 });
  }

  return semanticRowCount > 0 ? { rows, hunkRows } : null;
}

/** Resolve the one gallery view appropriate for a selected real file. */
function galleryViewForFile(file: ExtensionDiffFile | null) {
  if (!file) return null;
  const paths = [file.path, file.previousPath].filter((path): path is string => Boolean(path));
  if (paths.some((path) => /(?:^|[\\/])package\.json$/i.test(path))) {
    return "dependency-delta";
  }
  if (file.language === "css" || paths.some((path) => /\.css$/i.test(path))) {
    return "palette-delta";
  }
  if (
    file.language === "typescript" ||
    file.language === "javascript" ||
    paths.some((path) => /\.[cm]?[jt]sx?$/i.test(path))
  ) {
    return "change-atlas";
  }
  return null;
}

/** Register three opt-in constrained-JSX presentations behind one contextual command. */
const register: ExtensionFactory = (hunk) => {
  hunk.registerFileView({
    id: "change-atlas",
    title: "JSX demo: Change atlas",
    matches: (file) => galleryViewForFile(file) === "change-atlas",
    layout: createChangeAtlasLayout,
  });
  hunk.registerFileView({
    id: "palette-delta",
    title: "JSX demo: CSS palette delta",
    matches: (file) => galleryViewForFile(file) === "palette-delta",
    layout: createCssPaletteLayout,
  });
  hunk.registerFileView({
    id: "dependency-delta",
    title: "JSX demo: Dependency delta",
    matches: (file) => galleryViewForFile(file) === "dependency-delta",
    layout: createDependencyLayout,
  });

  hunk.registerCommand(
    { id: "toggle-jsx-gallery", title: "Toggle JSX demo for current file", key: "f8" },
    (ctx) => {
      const viewId = galleryViewForFile(ctx.selection.file);
      if (viewId) {
        ctx.fileViews.toggle(viewId);
      } else {
        ctx.notify("The JSX gallery has no demo for this file type.", "info");
      }
    },
  );
};

export default register;
