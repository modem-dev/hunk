/**
 * Holds the stateful half of content search: one query, one target list, one cursor into it.
 *
 * The session lives for the process (bundled factories run once), so it never holds a review of
 * its own: every search and repeat receives the visible files from the command's selection and
 * rebuilds targets when that list changes identity. Hidden files therefore never become targets,
 * and a reload keeps the query while orphaning the old current target, whose file object and
 * hunk indexes no longer exist. A layout change re-sorts the targets into the new on-screen order
 * and keeps the current target by identity. Kept out of `index.ts` so a unit test can drive a
 * fresh query, a repeat in either direction, and a corpus change without a host.
 */
import type {
  ExtensionDiffFile,
  ExtensionLineHighlight,
  ExtensionStatusSpan,
} from "../../../../extension-api/types";
import {
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  lineOrderKey,
  parsePatchLines,
  stepToTarget,
  type SearchDirection,
  type SearchLayout,
  type SearchMode,
  type SearchTarget,
} from "./search";

/** Where the review is pointing, as the search compares positions. */
export interface SearchPosition {
  fileId: string | null;
  hunkIndex: number | null;
  /** The cursor line, so stepping starts from it rather than from its hunk. */
  currentLine: { side: "old" | "new"; line: number } | null;
}

/** What a search or repeat asks the host to do. */
export type SearchOutcome =
  | { kind: "moved"; target: SearchTarget; index: number; total: number; wrapped: boolean }
  | { kind: "no-matches"; query: string }
  | { kind: "no-query" }
  | { kind: "invalid-query"; query: string; error: string };

export interface SearchSessionOptions {
  mode: SearchMode;
}

export interface SearchSession {
  /** The active query, or `null` before the first successful search or after `clear`. */
  readonly query: string | null;
  /** How many match occurrences the active query has in the last corpus searched. */
  readonly total: number;
  /**
   * Run a new query over `files` from `position`, like typing `/pattern` in `less`. Matches on
   * the cursor line, or in the selected hunk, count as ahead, unlike a repeat.
   */
  search(
    query: string,
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
    layout: SearchLayout,
  ): SearchOutcome;
  /** Repeat the active query over `files`, like `n` / `N`. */
  repeat(
    direction: SearchDirection,
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
    layout: SearchLayout,
  ): SearchOutcome;
  /** Forget the query so the diff paints no marks and repeats report no query. */
  clear(): void;
  /**
   * The diff marks the active query paints on one file, for the registered
   * line highlighter. `null` before the first search, so an idle session
   * paints nothing.
   */
  marksFor(file: ExtensionDiffFile): ExtensionLineHighlight[] | null;
}

/** Create one search session for the life of the bundled extension. */
export function createSearchSession(options: SearchSessionOptions): SearchSession {
  // The last corpus targets were built from; a different array identity means
  // the visible files changed (reload, filter) and the targets are stale.
  let corpus: readonly ExtensionDiffFile[] | null = null;
  let layout: SearchLayout = "unified";
  let query: string | null = null;
  let targets: SearchTarget[] = [];
  // The target the review last jumped to — what marksFor paints as "current".
  let current: SearchTarget | null = null;

  function rebuildTargets(files: readonly ExtensionDiffFile[]) {
    const compiled = query === null ? null : compileQuery(query, options.mode);
    targets = compiled?.ok ? findTargets(files, compiled.locate, layout) : [];
  }

  /**
   * Rebuild targets when the corpus or layout changed. A new corpus orphans the current target;
   * a new layout only re-sorts, so the current target is found again by identity.
   */
  function adopt(files: readonly ExtensionDiffFile[], nextLayout: SearchLayout) {
    const corpusChanged = files !== corpus;
    if (!corpusChanged && nextLayout === layout) {
      return;
    }

    corpus = files;
    layout = nextLayout;
    rebuildTargets(files);
    const previous = current;
    current =
      corpusChanged || previous === null
        ? null
        : (targets.find((target) => sameOccurrence(target, previous)) ?? null);
  }

  /**
   * The rank prefix a step starts from, at the finest granularity the position supports.
   *
   * Repeats are strict, so `n` always moves. A fresh search is `inclusive`: a line or hunk prefix
   * gets a trailing `-1` so matches on the cursor line, or in the selected hunk, still count as
   * ahead of it.
   */
  function fromPrefix(
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
    inclusive: boolean,
  ) {
    const fileIndex = files.findIndex((file) => file.id === position.fileId);
    if (position.fileId === null || fileIndex === -1) {
      return null;
    }

    const { hunkIndex, currentLine } = position;
    if (
      current !== null &&
      current.fileId === position.fileId &&
      current.hunkIndex === hunkIndex &&
      (currentLine === null ||
        (currentLine.side === current.line.side && currentLine.line === current.line.lineNumber))
    ) {
      return current.rank;
    }

    // A file with no selected hunk ranks just before its first hunk, so a forward
    // search from a freshly opened file finds that file's own first match.
    if (hunkIndex === null) {
      return [fileIndex, -1];
    }

    const patch = files[fileIndex]?.patch;
    const line =
      currentLine === null || typeof patch !== "string"
        ? undefined
        : parsePatchLines(patch).find(
            (candidate) =>
              candidate.hunkIndex === hunkIndex &&
              candidate.side === currentLine.side &&
              candidate.lineNumber === currentLine.line,
          );
    const prefix = line
      ? [fileIndex, hunkIndex, ...lineOrderKey(line, layout)]
      : [fileIndex, hunkIndex];
    return inclusive ? [...prefix, -1] : prefix;
  }

  function move(
    direction: SearchDirection,
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
    inclusive = false,
  ): SearchOutcome {
    if (query === null) {
      return { kind: "no-query" };
    }

    if (targets.length === 0) {
      return { kind: "no-matches", query };
    }

    const step = stepToTarget(targets, fromPrefix(files, position, inclusive), direction);
    const target = step === null ? undefined : targets[step.index];
    if (step === null || !target) {
      return { kind: "no-matches", query };
    }

    current = target;
    return {
      kind: "moved",
      target,
      index: step.index + 1,
      total: targets.length,
      wrapped: step.wrapped,
    };
  }

  return {
    get query() {
      return query;
    },
    get total() {
      return targets.length;
    },
    search(raw, files, position, nextLayout) {
      const compiled = compileQuery(raw, options.mode);
      if (!compiled.ok) {
        // A bad query never clobbers a working one: the previous search stays
        // repeatable with `n`.
        return { kind: "invalid-query", query: raw, error: compiled.error };
      }

      query = raw;
      corpus = files;
      layout = nextLayout;
      rebuildTargets(files);
      current = null;
      return move("forward", files, position, true);
    },
    repeat(direction, files, position, nextLayout) {
      adopt(files, nextLayout);
      return move(direction, files, position);
    },
    clear() {
      query = null;
      targets = [];
      current = null;
    },
    marksFor(file) {
      if (query === null) {
        return null;
      }

      const compiled = compileQuery(query, options.mode);
      if (!compiled.ok) {
        return null;
      }

      return collectFileMatchMarks(
        file,
        compiled.locate,
        current === null
          ? null
          : {
              fileId: current.fileId,
              hunkIndex: current.hunkIndex,
              lineOffset: current.line.offset,
              matchStart: current.line.matchRange[0],
            },
      );
    },
  };
}

/**
 * Render one outcome as the status-line spans the user reads, with symbolic tones.
 *
 * A hit reads `[i/n] path:line • wrapped — quoted text`; misses and bad queries
 * borrow the diff's removal tone so they stand out from the muted location text.
 */
export function formatOutcomeSpans(outcome: SearchOutcome): ExtensionStatusSpan[] {
  switch (outcome.kind) {
    case "moved": {
      const { target, index, total, wrapped } = outcome;
      const location =
        target.line.lineNumber === null ? target.path : `${target.path}:${target.line.lineNumber}`;
      const wrap = wrapped ? " • wrapped" : "";
      return [
        { text: `[${index}/${total}] `, tone: "accent" },
        { text: `${location}${wrap}`, tone: "muted" },
        { text: ` — ${truncate(target.line.text.trim(), 60)}` },
      ];
    }
    case "no-matches":
      return [{ text: `No match for "${outcome.query}"`, tone: "removed" }];
    case "no-query":
      return [{ text: "No search yet — press / to search", tone: "muted" }];
    case "invalid-query":
      return [{ text: `Bad search "${outcome.query}" • ${outcome.error}`, tone: "removed" }];
  }
}

/** Clip quoted source text so the status item stays one readable line. */
function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Whether two targets are the same match occurrence, whatever order they sort in. */
function sameOccurrence(a: SearchTarget, b: SearchTarget) {
  return (
    a.fileId === b.fileId &&
    a.hunkIndex === b.hunkIndex &&
    a.line.offset === b.line.offset &&
    a.line.matchRange[0] === b.line.matchRange[0]
  );
}
