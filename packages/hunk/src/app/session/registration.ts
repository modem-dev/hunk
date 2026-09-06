import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveExperimentalFeatures } from "../../core/run/experimental";
import { isVcsReviewInput } from "../../core/vcs";
import { summarizeHunk } from "../../core/changeset/hunkSummary";
import { reviewHunkRanges } from "../../core/review/geometry";
import { reviewProcessCapability } from "../review/capability";
import type { ReviewPublication } from "../review/publication";
import type { AppBootstrap } from "../../core/bootstrap";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  resolveSessionTerminalMetadata,
} from "@hunk/session-broker-core";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  SessionReviewFile,
} from "../../session/types";

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
 *
 * Patch text is deliberately absent. It is published as a resource instead, read on
 * demand in bounded verified chunks, so the daemon holds one patch at a time rather than
 * every patch of every live session for as long as those sessions are open — and a review
 * whose patches exceed the registration budget registers normally instead of failing to
 * appear at all.
 */
function buildSessionFiles(publication: ReviewPublication): SessionReviewFile[] {
  return publication.document.files.map((file) => ({
    id: file.runtimeId,
    path: file.path,
    previousPath: file.previousPath,
    additions: file.stats.additions,
    deletions: file.stats.deletions,
    hunkCount: file.hunks.length,
    // The same derivation the extension API's file views use, so the two
    // external views of a review never disagree on a hunk's header or spans.
    hunks: file.hunks.map((hunk, index) => summarizeHunk(hunk, index)),
  }));
}

/** Describe the generation and the resources it offers, for the broker's review mirror. */
function buildReviewCatalog(publication: ReviewPublication): HunkReviewResourceCatalogV1 {
  return {
    generation: publication.generation,
    fileKeysByRuntimeId: Object.fromEntries(
      publication.document.files.map((file) => [file.runtimeId, file.key]),
    ),
    resources: [...publication.resources],
  };
}

/** Build the broker-facing envelope for one live Hunk review session. */
export function createSessionRegistration(
  bootstrap: AppBootstrap,
  publication: ReviewPublication,
  cwd = process.cwd(),
): HunkSessionRegistration {
  const terminal = resolveSessionTerminalMetadata({ tty: ttyname() });

  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: randomUUID(),
    pid: process.pid,
    cwd,
    repoRoot: inferRepoRoot(bootstrap),
    launchedAt: new Date().toISOString(),
    terminal,
    info: {
      inputKind: bootstrap.input.kind,
      title: bootstrap.changeset.title,
      sourceLabel: bootstrap.changeset.sourceLabel,
      experimentalFeatures: resolveExperimentalFeatures(bootstrap.input.options),
      ...(bootstrap.review ? { review: bootstrap.review } : {}),
      files: buildSessionFiles(publication),
      reviewCatalog: buildReviewCatalog(publication),
      // The verifier, not the secret: the daemon can check a presented capability and can
      // never hand one out.
      reviewCapabilityDigest: reviewProcessCapability().digest,
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
      ...(bootstrap.review ? { review: bootstrap.review } : {}),
      files: buildSessionFiles(publication),
      reviewCatalog: buildReviewCatalog(publication),
      // The verifier, not the secret: the daemon can check a presented capability and can
      // never hand one out.
      reviewCapabilityDigest: reviewProcessCapability().digest,
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
      // A fresh generation starts at the store's own first revision; every later snapshot
      // reports where the review has since moved so the mirror can order them.
      reviewPublication: { generation: publication.generation, stateRevision: 0 },
    },
  };
}
