import { randomUUID } from "node:crypto";
import { canReloadInput } from "../../core/inputReload";
import { spawnSync } from "node:child_process";
import { resolveExperimentalFeatures, resolveExperimentalDiffFiles } from "../../core/experimental";
import { summarizeHunk } from "../../core/hunkSummary";
import { projectReviewDocument } from "../../core/review/document";
import { reviewInputSourceIdentity } from "../../core/review/sourceIdentity";
import type { ReviewDocumentV1 } from "../../core/review/types";
import { createInitialReviewState, type ReviewState } from "../../core/review/state";
import type { AppBootstrap } from "../../core/types";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  resolveSessionTerminalMetadata,
  utf8ByteLength,
} from "@hunk/session-broker-core";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  assertReviewProducerEnvelopeWithinBounds,
  MAX_REVIEW_MANIFEST_BYTES,
  MAX_REVIEW_NOTE_BYTES,
  MAX_REVIEW_PRODUCER_METADATA_BYTES,
  MAX_REVIEW_RESOURCE_BYTES,
  MAX_REVIEW_RESOURCE_DESCRIPTORS,
  isReviewSha256Digest,
  type HunkReviewManifestV1,
} from "../reviewProtocol";
import type { HunkSessionRegistration, HunkSessionSnapshot, SessionReviewFile } from "../types";
import { createSessionSnapshotFromReviewState } from "./reviewSnapshot";

/** Resolve the TTY device path for the current process, if available. */
function ttyname(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
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
  return bootstrap.input.kind === "vcs" ||
    bootstrap.input.kind === "show" ||
    bootstrap.input.kind === "stash-show"
    ? bootstrap.changeset.sourceLabel
    : undefined;
}

/** Resolve a projection for compatibility callers that do not yet own a runtime. */
function resolveDocument(bootstrap: AppBootstrap, document?: ReviewDocumentV1) {
  if (document) return document;
  const files = resolveExperimentalDiffFiles(bootstrap.changeset.files, bootstrap.input.options);
  return projectReviewDocument(
    { ...bootstrap.changeset, files },
    { sourceIdentity: reviewInputSourceIdentity(bootstrap.input, bootstrap.reloadContext) },
  ).document;
}

/** Build the bounded ordered review manifest carried in producer registration. */
export function createHunkReviewManifest(
  bootstrap: AppBootstrap,
  document: ReviewDocumentV1,
): HunkReviewManifestV1 {
  if (document.files.length !== bootstrap.changeset.files.length) {
    throw new Error("Review manifest file count does not match the authoritative document.");
  }
  if (document.resources.length > MAX_REVIEW_RESOURCE_DESCRIPTORS) {
    throw new Error("Review manifest has too many resource descriptors.");
  }
  for (const resource of document.resources) {
    if (resource.byteLength !== undefined && resource.byteLength > MAX_REVIEW_RESOURCE_BYTES) {
      throw new Error(`Review resource ${resource.id} exceeds the per-resource limit.`);
    }
    if (resource.digest !== undefined && !isReviewSha256Digest(resource.digest)) {
      throw new Error(`Review resource ${resource.id} has an invalid SHA-256 digest.`);
    }
  }
  for (const file of document.files) {
    for (const note of file.notes) {
      if (utf8ByteLength(JSON.stringify(note)) > MAX_REVIEW_NOTE_BYTES) {
        throw new Error(`Review note ${note.id} exceeds the note metadata limit.`);
      }
    }
  }

  const manifest: HunkReviewManifestV1 = {
    version: HUNK_REVIEW_PROTOCOL_VERSION,
    generation: document.generation,
    documentIdentity: document.documentIdentity,
    changesetId: document.changesetId,
    title: document.title,
    sourceLabel: document.sourceLabel,
    ...(document.summary !== undefined ? { summary: document.summary } : {}),
    ...(document.agentSummary !== undefined ? { agentSummary: document.agentSummary } : {}),
    files: document.files.map((file) => {
      return {
        key: file.key,
        runtimeId: file.runtimeId,
        path: file.path,
        ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
        changeKind: file.changeKind,
        ...(file.language !== undefined ? { language: file.language } : {}),
        ...(file.agentSummary !== undefined ? { agentSummary: file.agentSummary } : {}),
        additions: file.stats.additions,
        deletions: file.stats.deletions,
        statsTruncated: file.stats.truncated,
        hunkCount: file.hunks.length,
        hasTrailingContext: (() => {
          const last = file.hunks.at(-1);
          if (!last || file.flags.partial) return false;
          const additions =
            file.additionLines.length - (last.additionLineIndex + last.additionCount);
          const deletions =
            file.deletionLines.length - (last.deletionLineIndex + last.deletionCount);
          return additions > 0 && additions === deletions;
        })(),
        flags: { ...file.flags },
        patchResourceId: file.patchResourceId,
        canonicalResourceId: file.canonicalResourceId,
        sourceResourceIds: { ...file.sourceResourceIds },
        hunks: file.hunks.map((hunk, hunkIndex) => summarizeSessionHunk(hunk, hunkIndex)),
        notes: file.notes.map((note) => structuredClone(note)),
      };
    }),
    resources: document.resources.map((resource) => ({ ...resource })),
    capabilities: {
      actions: [
        "selection/select",
        "selection/set-line",
        "filter/set",
        "notes/set-visibility",
        "notes/create-user",
        "notes/update-user",
        "notes/remove-user",
        "notes/remove-live",
        "expansion/toggle",
        "session/reload",
        "trust/decide",
      ],
      canReload: canReloadInput(bootstrap.input),
    },
  };

  if (utf8ByteLength(JSON.stringify(manifest)) > MAX_REVIEW_MANIFEST_BYTES) {
    throw new Error("Review manifest exceeds the producer metadata limit.");
  }
  return manifest;
}

/** Omit Pierre's zero-line sentinel ranges from the positive-line session protocol. */
function summarizeSessionHunk(
  hunk: Parameters<typeof summarizeHunk>[0],
  index: number,
): SessionReviewFile["hunks"][number] {
  const summary = summarizeHunk(hunk, index);
  return {
    index: summary.index,
    header: summary.header,
    ...(summary.oldRange?.[0] && summary.oldRange[0] > 0 ? { oldRange: summary.oldRange } : {}),
    ...(summary.newRange?.[0] && summary.newRange[0] > 0 ? { newRange: summary.newRange } : {}),
  };
}

/** Convert manifest files into the legacy daemon review projection without patch bodies. */
function buildSessionFiles(manifest: HunkReviewManifestV1): SessionReviewFile[] {
  return manifest.files.map((file) => ({
    id: file.runtimeId,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    additions: file.additions,
    deletions: file.deletions,
    hunkCount: file.hunkCount,
    flags: { ...file.flags },
    hunks: file.hunks,
  }));
}

/** Build the broker-facing envelope for one live Hunk review session. */
export function createSessionRegistration(
  bootstrap: AppBootstrap,
  authoritativeDocument?: ReviewDocumentV1,
  options: { browserReviewCapabilityHash?: string } = {},
): HunkSessionRegistration {
  const terminal = resolveSessionTerminalMetadata({ tty: ttyname() });
  const document = resolveDocument(bootstrap, authoritativeDocument);
  const reviewManifest = createHunkReviewManifest(bootstrap, document);
  if (
    options.browserReviewCapabilityHash !== undefined &&
    !/^[a-f\d]{64}$/.test(options.browserReviewCapabilityHash)
  ) {
    throw new Error("Browser review capability verifier must be a lowercase SHA-256 digest.");
  }
  const info: HunkSessionRegistration["info"] = {
    inputKind: bootstrap.input.kind,
    title: bootstrap.changeset.title,
    sourceLabel: bootstrap.changeset.sourceLabel,
    experimentalFeatures: resolveExperimentalFeatures(bootstrap.input.options),
    ...(options.browserReviewCapabilityHash !== undefined
      ? { browserReviewCapabilityHash: options.browserReviewCapabilityHash }
      : {}),
    documentGeneration: document.generation,
    reviewManifest,
    files: buildSessionFiles(reviewManifest),
  };
  if (utf8ByteLength(JSON.stringify(info)) > MAX_REVIEW_PRODUCER_METADATA_BYTES) {
    throw new Error("Review registration exceeds the producer message metadata limit.");
  }
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: randomUUID(),
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: inferRepoRoot(bootstrap),
    launchedAt: new Date().toISOString(),
    terminal,
    info,
  };
}

/** Validate the complete register frame rather than its independently bounded payload parts. */
export function assertSessionRegistrationEnvelopeWithinBounds(
  registration: HunkSessionRegistration,
  snapshot: HunkSessionSnapshot,
) {
  assertReviewProducerEnvelopeWithinBounds(
    { type: "register", registration, snapshot },
    "Session registration",
  );
}

/** Rebuild registration metadata after reload while preserving session identity. */
export function updateSessionRegistration(
  current: HunkSessionRegistration,
  bootstrap: AppBootstrap,
  authoritativeDocument?: ReviewDocumentV1,
): HunkSessionRegistration {
  const next = createSessionRegistration(bootstrap, authoritativeDocument, {
    browserReviewCapabilityHash: current.info?.browserReviewCapabilityHash,
  });
  return {
    ...current,
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    repoRoot: next.repoRoot,
    info: next.info,
  };
}

/** Build the first broker snapshot from the authoritative store when available. */
export function createInitialSessionSnapshot(
  bootstrap: AppBootstrap,
  authoritativeState?: ReviewState,
): HunkSessionSnapshot {
  const document = authoritativeState?.document ?? resolveDocument(bootstrap);
  const state =
    authoritativeState ??
    createInitialReviewState(document, {
      showAgentNotes: bootstrap.initialShowAgentNotes ?? false,
    });
  return createSessionSnapshotFromReviewState(state);
}
