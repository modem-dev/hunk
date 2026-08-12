import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveExperimentalFeatures } from "../../core/experimental";
import { isVcsReviewInput } from "../../core/vcs";
import { summarizeHunk } from "../../core/hunkSummary";
import { reviewHunkRanges } from "../../core/review/geometry";
import type { ReviewPublication } from "../../app/review/publication";
import type { AppBootstrap } from "../../core/types";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  resolveSessionTerminalMetadata,
} from "@hunk/session-broker-core";
import type { HunkSessionRegistration, HunkSessionSnapshot, SessionReviewFile } from "../types";

/** Resolve the TTY device path for the current process, if available. */
function ttyname(): string | undefined {
  if (!process.stdin.isTTY) {
    return undefined;
  }

  try {
    const result = spawnSync("tty", [], { stdio: ["inherit", "pipe", "pipe"] });
    const name = result.stdout?.toString().trim();
    return name && !name.startsWith("not a tty") ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Infer the repo-root selector that remote session commands should match for this review input. */
function inferRepoRoot(bootstrap: AppBootstrap) {
  return isVcsReviewInput(bootstrap.input) ? bootstrap.changeset.sourceLabel : undefined;
}

/**
 * Convert one published generation into the app-owned file-and-hunk review export model.
 *
 * Projected from the semantic document rather than from the changeset behind it: the
 * session surface is a consumer of the published review like any other, so what an agent
 * reads through `hunk session` and what a later client reads over the wire come from the
 * same generation instead of from two readings of the same changeset.
 */
function buildSessionFiles(publication: ReviewPublication): SessionReviewFile[] {
  return publication.document.files.map((file) => ({
    id: file.runtimeId,
    path: file.path,
    previousPath: file.previousPath,
    additions: file.stats.additions,
    deletions: file.stats.deletions,
    hunkCount: file.hunks.length,
    patch: file.patch,
    // The same derivation the extension API's file views use, so the two
    // external views of a review never disagree on a hunk's header or spans.
    hunks: file.hunks.map((hunk, index) => summarizeHunk(hunk, index)),
  }));
}

/** Build the broker-facing envelope for one live Hunk review session. */
export function createSessionRegistration(
  bootstrap: AppBootstrap,
  publication: ReviewPublication,
): HunkSessionRegistration {
  const terminal = resolveSessionTerminalMetadata({ tty: ttyname() });

  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: randomUUID(),
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: inferRepoRoot(bootstrap),
    launchedAt: new Date().toISOString(),
    terminal,
    info: {
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      experimentalFeatures: resolveExperimentalFeatures(bootstrap.input.options),
      files: buildSessionFiles(publication),
    },
  };
}

/** Rebuild registration metadata after a live session reload while preserving session identity. */
export function updateSessionRegistration(
  current: HunkSessionRegistration,
  bootstrap: AppBootstrap,
  publication: ReviewPublication,
): HunkSessionRegistration {
  return {
    ...current,
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    repoRoot: inferRepoRoot(bootstrap),
    info: {
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      experimentalFeatures: resolveExperimentalFeatures(bootstrap.input.options),
      files: buildSessionFiles(publication),
    },
  };
}

/** Start with an empty-but-valid snapshot until the UI reports its first selection. */
export function createInitialSessionSnapshot(
  bootstrap: AppBootstrap,
  publication: ReviewPublication,
): HunkSessionSnapshot {
  const firstFile = publication.document.files[0];
  const firstHunk = firstFile?.hunks[0];
  const firstRange = firstHunk ? reviewHunkRanges(firstHunk) : null;

  return {
    updatedAt: new Date().toISOString(),
    state: {
      selectedFileId: firstFile?.runtimeId,
      selectedFilePath: firstFile?.path,
      selectedHunkIndex: 0,
      selectedHunkOldRange: firstRange?.oldRange,
      selectedHunkNewRange: firstRange?.newRange,
      showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
      liveCommentCount: 0,
      liveComments: [],
      reviewNoteCount: 0,
      reviewNotes: [],
    },
  };
}
