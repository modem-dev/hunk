/**
 * Non-interactive `hunk --color-only` filter for Git's `interactive.diffFilter`.
 *
 * Git commands such as `git add -p` pipe a diff through `interactive.diffFilter` and re-parse
 * the filter's stdout to drive their own prompts, so unlike the static pager this adapter must
 * keep the unified diff structure intact: after stripping ANSI escapes, every emitted line has
 * to match the input line exactly, in the same order. The raw input lines therefore stay the
 * source of truth here, and Hunk's normal parse/highlight stack (`loadAppBootstrap`, Pierre
 * metadata, `loadHighlightedDiff`, `buildStackRows`) only picks colors — never layout. Keep it a
 * thin adapter: no second diff parser, no row chrome, no line-number gutters, no tab expansion.
 * When a line fails to align with the parsed model it keeps its whole-line theme color so Git
 * pipelines keep working, and non-diff input passes through unchanged.
 */
import { loadAppBootstrap } from "../core/loaders";
import { looksLikePatchInput } from "../core/pager";
import { stripTerminalControl } from "../core/patch/normalize";
import type { CommonOptions, DiffFile, NamedCustomThemeConfig } from "../core/types";
import { buildStackRows, loadHighlightedDiff, type DiffRow } from "./diff/pierre";
import { stackCellPalette } from "./diff/rowStyle";
import { resolveTheme, withTransparentSurfaces, type AppTheme } from "./themes";

const RESET = "\x1b[0m";

/** Convert a six-digit hex color into one ANSI truecolor code. */
function ansiColor(kind: "fg" | "bg", hex: string | undefined) {
  const normalized = hex?.replace(/^#/, "");
  if (!normalized || !/^[0-9a-f]{6}$/i.test(normalized)) {
    return "";
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1b[${kind === "fg" ? 38 : 48};2;${red};${green};${blue}m`;
}

/**
 * Wrap one literal text fragment in ANSI colors.
 *
 * Unlike the static pager's variant this never sanitizes: filter output is re-parsed by Git, so
 * content bytes are data. Escape sequences were already stripped from the whole input up front.
 */
function colorText(text: string, fg?: string, bg?: string) {
  if (!text) {
    return "";
  }

  const prefix = `${ansiColor("fg", fg)}${ansiColor("bg", bg)}`;
  return prefix ? `${prefix}${text}${RESET}` : text;
}

/** Roles one input line can play in a unified diff, resolved by a small order-aware state machine. */
type FilterLineKind =
  | "file-header"
  | "file-meta"
  | "old-file-header"
  | "new-file-header"
  | "hunk-header"
  | "context"
  | "deletion"
  | "addition"
  | "no-newline"
  | "plain";

type WalkSection = "outside" | "file-header" | "hunks";

const FILE_META_PREFIXES = [
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "new file mode ",
  "deleted file mode ",
  "old tree ",
  "new tree ",
];

/**
 * Classify one patch line and advance the walk state.
 *
 * `+++`/`---` only introduce file paths inside a `diff --git` header block; inside a hunk body
 * they are ordinary content whose text starts with `+`/`-`, which is why the section matters.
 */
function classifyDiffLine(line: string, section: { value: WalkSection }): FilterLineKind {
  if (line.startsWith("diff --git ")) {
    section.value = "file-header";
    return "file-header";
  }

  // A hunk header opens a hunk body wherever it appears; `looksLikePatchInput` only admits
  // text that carries diff markers somewhere, so a leading `@@` is never free prose.
  if (line.startsWith("@@")) {
    section.value = "hunks";
    return "hunk-header";
  }

  if (section.value === "file-header") {
    if (line.startsWith("--- ")) {
      return "old-file-header";
    }

    if (line.startsWith("+++ ")) {
      return "new-file-header";
    }

    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch") ||
      FILE_META_PREFIXES.some((prefix) => line.startsWith(prefix))
    ) {
      return "file-meta";
    }

    return "plain";
  }

  if (section.value === "hunks") {
    if (line.startsWith("-")) {
      return "deletion";
    }

    if (line.startsWith("+")) {
      return "addition";
    }

    if (line.startsWith(" ")) {
      return "context";
    }

    if (line.startsWith("\\")) {
      return "no-newline";
    }

    return "plain";
  }

  if (line.startsWith("--- ")) {
    section.value = "file-header";
    return "old-file-header";
  }

  return "plain";
}

/** Content-line kinds that map one-to-one onto the model's stack cell kinds. */
type ContentKind = "context" | "deletion" | "addition";

/** Per-file alignment state between raw patch lines and Pierre's stack rows. */
interface HighlightGuide {
  rows: DiffRow[];
  cursor: number;
  /** False once the raw walk and the model disagree; re-enabled at the next hunk header. */
  spansEnabled: boolean;
}

/** Preload one file's stack rows so the line walk can consume them synchronously. */
async function buildHighlightGuide(file: DiffFile, theme: AppTheme): Promise<HighlightGuide> {
  const highlighted =
    file.isBinary || file.isTooLarge ? null : await loadHighlightedDiff(file, theme);
  return {
    rows: buildStackRows(file, highlighted, theme),
    cursor: 0,
    spansEnabled: true,
  };
}

/**
 * Move the guide to the model hunk the next raw `@@` line opens.
 *
 * Stack rows left unconsumed mean the raw walk skipped lines (or classified them as plain), so
 * they are dropped rather than allowed to misalign the hunk that follows.
 */
function consumeHunkHeader(guide: HighlightGuide) {
  const headerIndex = guide.rows.findIndex(
    (row, index) => index >= guide.cursor && row.type === "hunk-header",
  );
  if (headerIndex === -1) {
    guide.spansEnabled = false;
    return;
  }

  guide.cursor = headerIndex + 1;
}

/**
 * Take the next stack row for one raw content line, or null when the model has none left in
 * this hunk. Collapsed gap rows have no raw counterpart and are skipped. The row is consumed
 * only when its kind matches the raw line, so one mismatched row cannot cascade.
 */
function nextStackRow(
  guide: HighlightGuide,
  kind: ContentKind,
): Extract<DiffRow, { type: "stack-line" }> | null {
  while (guide.cursor < guide.rows.length) {
    const row = guide.rows[guide.cursor]!;
    if (row.type === "collapsed") {
      guide.cursor += 1;
      continue;
    }

    if (row.type !== "stack-line" || row.cell.kind !== kind) {
      return null;
    }

    guide.cursor += 1;
    return row;
  }

  return null;
}

/** Render one context/added/removed line, using highlight spans only when their text matches. */
function renderContentLine(
  line: string,
  kind: ContentKind,
  guide: HighlightGuide | null,
  theme: AppTheme,
) {
  const sign = line[0]!;
  const content = line.slice(1);
  const row = guide && guide.spansEnabled ? nextStackRow(guide, kind) : null;
  // Spans are trusted only when the model reconstructed this exact line; tab-expanded or
  // normalized model text would rewrite content bytes, so those lines keep whole-line color.
  const aligned = row !== null && row.cell.spans.map((span) => span.text).join("") === content;
  const palette = stackCellPalette(kind, theme, aligned ? row.cell.moveKind : undefined);
  const background = kind === "context" ? undefined : palette.contentBg;
  const signPart =
    kind === "context" ? colorText(sign) : colorText(sign, palette.signColor, background);
  const body = aligned
    ? row.cell.spans.map((span) => colorText(span.text, span.fg, span.bg ?? background)).join("")
    : colorText(content, undefined, background);

  return `${signPart}${body}`;
}

/** Colorize one classified line with whole-line theme colors. */
function renderStructuralLine(line: string, kind: FilterLineKind, theme: AppTheme): string {
  switch (kind) {
    case "file-header":
      return colorText(line, theme.text);
    case "file-meta":
    case "no-newline":
      return colorText(line, theme.muted);
    case "old-file-header":
      return colorText(line, theme.badgeRemoved);
    case "new-file-header":
      return colorText(line, theme.badgeAdded);
    case "hunk-header":
      return colorText(line, theme.badgeNeutral, theme.panelAlt);
    default:
      return line;
  }
}

function fallbackMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error || "unknown error");
}

function warnFallback(deps: ColorOnlyFilterDeps, reason: string) {
  deps.stderr?.write(
    `hunk: --color-only highlight failed; falling back to plain diff colors (${reason}).\n`,
  );
}

export interface ColorOnlyFilterDeps {
  customThemes?: readonly NamedCustomThemeConfig[];
  stderr?: Pick<NodeJS.WriteStream, "write">;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
}

/** Colorize escape-stripped patch text line by line, guided by the parsed model when available. */
function colorizeLines(
  text: string,
  theme: AppTheme,
  guides: readonly (HighlightGuide | null)[] | null,
) {
  const section: { value: WalkSection } = { value: "outside" };
  let fileIndex = 0;
  let guide: HighlightGuide | null = guides?.[0] ?? null;

  return text
    .split("\n")
    .map((line) => {
      // Preserve a carriage return from CRLF input after the colored segment.
      const carriage = line.endsWith("\r") ? "\r" : "";
      const base = carriage ? line.slice(0, -1) : line;
      const kind = classifyDiffLine(base, section);

      if (kind === "file-header") {
        fileIndex += 1;
        guide = guides?.[fileIndex - 1] ?? null;
      }

      if (kind === "hunk-header" && guide) {
        consumeHunkHeader(guide);
      }

      let rendered: string;
      if (kind === "context" || kind === "deletion" || kind === "addition") {
        rendered = renderContentLine(base, kind, guide, theme);
      } else {
        rendered = renderStructuralLine(base, kind, theme);
      }

      return `${rendered}${carriage}`;
    })
    .join("\n");
}

/** Color a unified diff from stdin for `git interactive.diffFilter` without the interactive UI. */
export async function renderColorOnlyDiff(
  text: string,
  options: CommonOptions = {},
  deps: ColorOnlyFilterDeps = {},
) {
  // A diffFilter must never mangle what it cannot colorize: non-diff input leaves unchanged.
  if (!looksLikePatchInput(text)) {
    return text;
  }

  const resolvedTheme = resolveTheme(options.theme, null, deps.customThemes);
  const theme = options.transparentBackground
    ? withTransparentSurfaces(resolvedTheme)
    : resolvedTheme;
  let guides: (HighlightGuide | null)[] | null = null;

  try {
    const bootstrap = await (deps.loadAppBootstrapImpl ?? loadAppBootstrap)({
      kind: "patch",
      file: "-",
      text,
      options: {
        ...options,
        pager: true,
      },
    });
    guides = await Promise.all(
      bootstrap.changeset.files.map((file) => buildHighlightGuide(file, theme)),
    );
  } catch (error) {
    warnFallback(deps, fallbackMessage(error));
  }

  return colorizeLines(stripTerminalControl(text), theme, guides);
}
