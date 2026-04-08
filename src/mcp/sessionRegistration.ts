import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { formatHunkHeader } from "../core/hunkHeader";
import { hunkLineRange } from "../core/liveComments";
import type { AppBootstrap } from "../core/types";
import { resolveSessionTerminalMetadata } from "./sessionTerminalMetadata";
import { HUNK_SESSION_REGISTRATION_VERSION } from "./sessionWire";
import type { HunkSessionRegistration, HunkSessionSnapshot, SessionReviewFile } from "./types";

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
  return bootstrap.input.kind === "git" ||
    bootstrap.input.kind === "show" ||
    bootstrap.input.kind === "stash-show"
    ? bootstrap.changeset.sourceLabel
    : undefined;
}

/** Convert the loaded changeset into the daemon's file-and-hunk review export model. */
function buildSessionFiles(bootstrap: AppBootstrap): SessionReviewFile[] {
  return bootstrap.changeset.files.map((file) => ({
    id: file.id,
    path: file.path,
    previousPath: file.previousPath,
    additions: file.stats.additions,
    deletions: file.stats.deletions,
    hunkCount: file.metadata.hunks.length,
    patch: file.patch,
    hunks: file.metadata.hunks.map((hunk, index) => ({
      index,
      header: formatHunkHeader(hunk),
      ...hunkLineRange(hunk),
    })),
  }));
}

/** Build the daemon-facing metadata for one live Hunk TUI session. */
export function createSessionRegistration(bootstrap: AppBootstrap): HunkSessionRegistration {
  const terminal = resolveSessionTerminalMetadata({ tty: ttyname() });

  return {
    registrationVersion: HUNK_SESSION_REGISTRATION_VERSION,
    sessionId: randomUUID(),
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: inferRepoRoot(bootstrap),
    inputKind: bootstrap.input.kind,
    title: bootstrap.changeset.title,
    sourceLabel: bootstrap.changeset.sourceLabel,
    launchedAt: new Date().toISOString(),
    terminal,
    files: buildSessionFiles(bootstrap),
  };
}

/** Rebuild registration metadata after a live session reload while preserving session identity. */
export function updateSessionRegistration(
  current: HunkSessionRegistration,
  bootstrap: AppBootstrap,
): HunkSessionRegistration {
  return {
    ...current,
    registrationVersion: HUNK_SESSION_REGISTRATION_VERSION,
    repoRoot: inferRepoRoot(bootstrap),
    inputKind: bootstrap.input.kind,
    title: bootstrap.changeset.title,
    sourceLabel: bootstrap.changeset.sourceLabel,
    files: buildSessionFiles(bootstrap),
  };
}

/** Start with an empty-but-valid snapshot until the UI reports its first selection. */
export function createInitialSessionSnapshot(bootstrap: AppBootstrap): HunkSessionSnapshot {
  const firstFile = bootstrap.changeset.files[0];
  const firstHunk = firstFile?.metadata.hunks[0];
  const firstRange = firstHunk ? hunkLineRange(firstHunk) : null;

  return {
    selectedFileId: firstFile?.id,
    selectedFilePath: firstFile?.path,
    selectedHunkIndex: 0,
    selectedHunkOldRange: firstRange?.oldRange,
    selectedHunkNewRange: firstRange?.newRange,
    showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    liveCommentCount: 0,
    liveComments: [],
    updatedAt: new Date().toISOString(),
  };
}
