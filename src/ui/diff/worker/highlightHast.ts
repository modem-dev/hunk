import { cleanLastNewline } from "@pierre/diffs";

/** Describes the HAST nodes Pierre returns for one syntax-highlighted line. */
export type HastNode = HastTextNode | HastElementNode;

interface HastTextNode {
  type: "text";
  value: string;
}

interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Preserves one terminal-relevant text run from Pierre's nested HAST. */
export interface HastHighlightRun {
  text: string;
  fg?: string;
  wordDiff: boolean;
}

const EMPTY_STYLE_VALUES = new Map<string, string>();
const parsedStyleValueCache = new Map<string, Map<string, string>>();

/** Parse one inline CSS style string from Pierre's highlighted HAST output. */
function parseStyleValue(styleValue: unknown) {
  if (typeof styleValue !== "string") {
    return EMPTY_STYLE_VALUES;
  }

  const cached = parsedStyleValueCache.get(styleValue);
  if (cached) {
    return cached;
  }

  const styles = new Map<string, string>();
  for (const segment of styleValue.split(";")) {
    const separator = segment.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key && value) {
      styles.set(key, value);
    }
  }

  parsedStyleValueCache.set(styleValue, styles);
  return styles;
}

/** Append a run while preserving the flattened text/style projection. */
function appendRun(target: HastHighlightRun[], next: HastHighlightRun) {
  if (next.text.length === 0) {
    return;
  }

  const previous = target[target.length - 1];
  if (previous && previous.fg === next.fg && previous.wordDiff === next.wordDiff) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}

/**
 * Flattens one Pierre HAST line into terminal-relevant text runs.
 *
 * This keeps syntax foreground inheritance and word-diff decoration semantic. Terminal-specific
 * background selection, text sanitization, tab expansion, and cell-width measurement remain local
 * to the renderer.
 */
export function collectHastHighlightRuns(node: HastNode | undefined, appearance: "dark" | "light") {
  if (!node) {
    return [];
  }

  const runs: HastHighlightRun[] = [];
  const colorVariable = appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";

  const visit = (
    current: HastNode | undefined,
    inherited: Pick<HastHighlightRun, "fg" | "wordDiff">,
  ) => {
    if (!current) {
      return;
    }

    if (current.type === "text") {
      // Pierre adds a newline placeholder to empty line nodes. The renderer strips it before
      // terminal layout, so compact ranges must use the same text projection.
      appendRun(runs, {
        text: cleanLastNewline(current.value),
        fg: inherited.fg,
        wordDiff: inherited.wordDiff,
      });
      return;
    }

    const styles = parseStyleValue(current.properties?.style);
    const nextStyle: Pick<HastHighlightRun, "fg" | "wordDiff"> = {
      fg: styles.get(colorVariable) ?? styles.get("color") ?? inherited.fg,
      wordDiff: Object.hasOwn(current.properties ?? {}, "data-diff-span") || inherited.wordDiff,
    };

    for (const child of current.children ?? []) {
      visit(child, nextStyle);
    }
  };

  visit(node, { wordDiff: false });
  return runs;
}
