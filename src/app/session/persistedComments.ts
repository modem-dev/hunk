/**
 * Persists the live session's review notes to a per-worktree file so they survive the
 * TUI exiting — including a SIGKILL from a closed terminal pane.
 *
 * The file lives under the worktree's Git metadata directory (`rev-parse
 * --absolute-git-dir`), so it never appears in `git status` and linked worktrees each
 * keep their own copy. Its `reviewNotes` array is the exact projection
 * `hunk session review --include-notes --json` publishes; the file mirrors the most
 * recent session that changed its notes and is export-only — sessions never read it back.
 */
import { join } from "node:path";
import { normalizePathForOS } from "../../lib/osPath";
import { writeAppStateRecord } from "../../core/process/appStateFile";
import type { SessionReviewNoteSummary } from "../../session/types";

export type PersistedReviewComments = {
  updatedAt: string;
  sourceLabel: string;
  reviewNotes: SessionReviewNoteSummary[];
};

/**
 * Resolve the persisted-comments path for one worktree, or undefined when the
 * directory is not inside a Git repository.
 */
export function resolvePersistedReviewCommentsPath(cwd: string): string | undefined {
  let gitDir: string;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    gitDir = result.stdout.toString().trim();
  } catch {
    return undefined;
  }

  return gitDir ? join(normalizePathForOS(gitDir), "hunk", "review-comments.json") : undefined;
}

/** Atomically replace the persisted-comments file with the session's current notes. */
export function writePersistedReviewComments(
  filePath: string,
  payload: PersistedReviewComments,
): void {
  writeAppStateRecord(filePath, payload);
}
