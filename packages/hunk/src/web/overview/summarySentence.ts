/**
 * Decides the one plain sentence the summary strip says about what a review mostly is.
 *
 * It reads only figures the shared overview already holds (`core/review/overview.ts`): the
 * totals, the largest files, and the top-level directories. Two rules apply in order and the
 * first that fits wins; when neither fits there is no sentence, which is the honest answer for
 * a review spread evenly. The result is structured, so the strip can put a path in the code
 * font and format every number with the page's own helpers.
 */
import type { ReviewOverview } from "../../core/review/overview";

/** The share of changed lines one file must hold to dominate a review. */
export const DOMINANT_FILE_SHARE = 0.8;

/** The share of files one top-level directory must hold to be where a review mostly is. */
export const DOMINANT_DIRECTORY_SHARE = 0.6;

/** A review dominated by one file, with the figures for everything else. */
export interface DominantFileSummary {
  kind: "file";
  path: string;
  additions: number;
  deletions: number;
  /** The file's own counts are a lower bound. */
  truncated: boolean;
  /** The review without that file; absent when some count is a lower bound and so is inexact. */
  rest?: { files: number; additions: number; deletions: number };
}

/** A review concentrated in one top-level directory. */
export interface DominantDirectorySummary {
  kind: "directory";
  /** The top-level directory's name, without a trailing slash. */
  directory: string;
  files: number;
  total: number;
}

export type SummarySentence = DominantFileSummary | DominantDirectorySummary;

/** Choose the sentence for one overview, or none. */
export function selectSummarySentence(overview: ReviewOverview): SummarySentence | undefined {
  const { totals } = overview;
  const totalChurn = totals.additions + totals.deletions;
  const largest = overview.largestFiles[0];

  if (largest && totals.files > 1 && totalChurn > 0) {
    const largestChurn = largest.additions + largest.deletions;
    if (largestChurn >= totalChurn * DOMINANT_FILE_SHARE) {
      return {
        kind: "file",
        path: largest.path,
        additions: largest.additions,
        deletions: largest.deletions,
        truncated: largest.truncated,
        // Subtracting from a lower bound would print a wrong figure as if it were exact.
        ...(totals.truncated
          ? {}
          : {
              rest: {
                files: totals.files - 1,
                additions: totals.additions - largest.additions,
                deletions: totals.deletions - largest.deletions,
              },
            }),
      };
    }
  }

  const directories = overview.directories.children;
  if (directories.length >= 2 && totals.files > 0) {
    // The tree compacts a single-child chain into one name (`packages/hunk/src`); the
    // top-level directory is its first segment.
    const top = directories.reduce((best, directory) =>
      directory.files > best.files ? directory : best,
    );
    if (top.files >= totals.files * DOMINANT_DIRECTORY_SHARE) {
      return {
        kind: "directory",
        directory: top.name.split("/")[0]!,
        files: top.files,
        total: totals.files,
      };
    }
  }

  return undefined;
}
