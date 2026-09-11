/**
 * Holds the stateful half of content search: one query, one target list, one cursor into it.
 *
 * The session lives for the process (bundled factories run once), so it never holds a review of
 * its own: every search and repeat receives the visible files from the command's selection and
 * rebuilds targets when that list changes identity. Hidden files therefore never become targets,
 * and a reload keeps the query while orphaning the old current target, whose file object and
 * hunk indexes no longer exist. Kept out of `index.ts` so a unit test can drive a fresh query, a
 * repeat in either direction, and a corpus change without a host.
 */
import type {
  ExtensionDiffFile,
  ExtensionLineHighlight,
  ExtensionStatusSpan,
} from "../../../../extension-api/types";
import {
  buildFileOrder,
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  stepToTarget,
  type SearchDirection,
  type SearchMode,
  type SearchPosition,
  type SearchTarget,
} from "./search";

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
  /** How many hunks the active query matches in the last corpus searched. */
  readonly total: number;
  /** Run a new query over `files` from `position`, like typing `/pattern` in `less`. */
  search(
    query: string,
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
  ): SearchOutcome;
  /** Repeat the active query over `files`, like `n` / `N`. */
  repeat(
    direction: SearchDirection,
    files: readonly ExtensionDiffFile[],
    position: SearchPosition,
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
  let fileOrder = new Map<string, number>();
  let query: string | null = null;
  let targets: SearchTarget[] = [];
  // The target the review last jumped to — what marksFor paints as "current".
  let current: SearchTarget | null = null;

  /** Rebuild targets when the corpus changed identity; a rebuilt list orphans the current target. */
  function adoptCorpus(files: readonly ExtensionDiffFile[]) {
    if (files === corpus) {
      return;
    }

    corpus = files;
    fileOrder = buildFileOrder(files);
    current = null;
    if (query === null) {
      targets = [];
      return;
    }

    const compiled = compileQuery(query, options.mode);
    targets = compiled.ok ? findTargets(files, compiled.locate) : [];
  }

  function move(direction: SearchDirection, position: SearchPosition): SearchOutcome {
    if (query === null) {
      return { kind: "no-query" };
    }

    if (targets.length === 0) {
      return { kind: "no-matches", query };
    }

    const step = stepToTarget(targets, fileOrder, position, direction);
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
    search(raw, files, position) {
      const compiled = compileQuery(raw, options.mode);
      if (!compiled.ok) {
        // A bad query never clobbers a working one: the previous search stays
        // repeatable with `n`.
        return { kind: "invalid-query", query: raw, error: compiled.error };
      }

      query = raw;
      corpus = files;
      fileOrder = buildFileOrder(files);
      targets = findTargets(files, compiled.locate);
      current = null;
      return move("forward", position);
    },
    repeat(direction, files, position) {
      adoptCorpus(files);
      return move(direction, position);
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
            },
      );
    },
  };
}

/**
 * Render one outcome as the status-line spans the user reads, with symbolic tones.
 *
 * A hit reads `[i/n] path:line (+k in hunk) • wrapped — quoted text`; misses and bad queries
 * borrow the diff's removal tone so they stand out from the muted location text.
 */
export function formatOutcomeSpans(outcome: SearchOutcome): ExtensionStatusSpan[] {
  switch (outcome.kind) {
    case "moved": {
      const { target, index, total, wrapped } = outcome;
      const location =
        target.line.lineNumber === null ? target.path : `${target.path}:${target.line.lineNumber}`;
      const more = target.count > 1 ? ` (+${target.count - 1} in hunk)` : "";
      const wrap = wrapped ? " • wrapped" : "";
      return [
        { text: `[${index}/${total}] `, tone: "accent" },
        { text: `${location}${more}${wrap}`, tone: "muted" },
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
