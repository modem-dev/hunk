import { describe, expect, test } from "bun:test";
import { DEFAULT_SESSION_BROKER_LIMITS } from "@hunk/session-broker-core";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import {
  connectReviewSession,
  createTestPatchFile,
} from "../../../../../test/helpers/review-session-harness";
import {
  MAX_PROJECTED_SIDECAR_NOTE_BYTES,
  MAX_REVIEW_NOTES_TOTAL_BYTES,
  MAX_SNAPSHOT_NOTE_SUMMARY_BYTES,
} from "../../core/review/noteSize";
import { selectStoredReviewNotes } from "../../core/review/selectors";
import type { DiffFile } from "../../core/changeset/model";
import { ReviewSessionHost } from "./reviewSessionHost";

/** A one-hunk file whose new line 8 changed, carrying the given sidecar annotations. */
function createTestBudgetFile(annotations: NonNullable<DiffFile["agent"]>["annotations"] = []) {
  const before = Array.from({ length: 12 }, (_unused, index) => `const v${index + 1} = ${index};`);
  const after = [...before];
  after[7] = "const v8 = 800;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id: "alpha",
    path: "src/alpha.ts",
    agent: { path: "src/alpha.ts", annotations },
  });
}

/** Sidecar annotations that together fill the sidecar byte bound. */
function createTestSidecarAnnotations() {
  return Array.from({ length: 1_100 }, (_unused, index) => ({
    newRange: [8, 8] as [number, number],
    summary: `${index} ${"s".repeat(1_000)}`,
    source: "ai" as const,
  }));
}

/** Add live comments of the given text length until the review refuses the next one. */
function fillTestLiveComments(host: ReviewSessionHost, textLength: number) {
  let added = 0;
  for (;;) {
    try {
      host.addLiveComment(
        {
          filePath: "src/alpha.ts",
          hunkIndex: 0,
          summary: `${added} ${"l".repeat(textLength)}`,
        },
        `mcp:${added}`,
      );
    } catch {
      return added;
    }
    added += 1;
  }
}

describe("session snapshot note budget", () => {
  // The daemon drops a session whose retained snapshot exceeds its per-session ceiling, and the
  // session re-registers the same state on every reconnect. Stored notes appear in two lists, so
  // a review at its stored-note limit used to exceed the ceiling by itself.
  test("a review at its note limits produces a snapshot the daemon accepts", () => {
    const files = [
      createTestBudgetFile(createTestSidecarAnnotations()),
      createTestPatchFile("b", 3),
    ];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    const added = fillTestLiveComments(host, 1_000);
    const stored = selectStoredReviewNotes(host.store.getSnapshot());
    // The review really is at its stored-note byte limit, not merely large.
    expect(added).toBeGreaterThan(1_400);
    expect(stored.length).toBe(added);

    const session = connectReviewSession(files);
    session.register();
    const state = host.getSessionSnapshotState({
      publicationGeneration: session.producer.getPublication().generation,
    });
    const snapshot = JSON.parse(JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", state }));
    const unbounded = 2 * added * 1_100 + MAX_PROJECTED_SIDECAR_NOTE_BYTES;
    expect(unbounded).toBeGreaterThan(DEFAULT_SESSION_BROKER_LIMITS.maxRetainedSessionBytes);

    expect(session.state.updateSnapshot(session.socket, session.sessionId, snapshot)).toBe(
      "updated",
    );
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MAX_SNAPSHOT_NOTE_SUMMARY_BYTES + 64 * 1024,
    );
    expect(state.liveCommentCount).toBe(state.liveComments.length);
    expect(state.reviewNoteCount).toBe(state.reviewNotes.length);
    // The summaries are a projection: the review itself still holds every note.
    expect(selectStoredReviewNotes(host.store.getSnapshot()).length).toBe(added);
  });

  test("stored notes claim the budget before sidecar annotations, in thread order", () => {
    const files = [createTestBudgetFile(createTestSidecarAnnotations())];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    const added = fillTestLiveComments(host, 1_000);
    const { liveComments, reviewNotes } = host.getSessionSnapshotState();

    const sidecarKept = reviewNotes.filter((note) => note.source === "ai").length;
    const storedKept = reviewNotes.length - sidecarKept;
    // The stored share is a prefix, so a kept comment never loses an earlier one.
    expect(liveComments.map((comment) => comment.commentId)).toEqual(
      Array.from({ length: liveComments.length }, (_unused, index) => `mcp:${index}`),
    );
    expect(storedKept).toBe(liveComments.length);
    expect(liveComments.length).toBeLessThanOrEqual(added);
    // Stored notes outrank sidecar annotations: the sidecar only keeps what is left over.
    expect(sidecarKept).toBeLessThan(createTestSidecarAnnotations().length);
    const bytes = JSON.stringify(liveComments).length + JSON.stringify(reviewNotes).length;
    expect(bytes).toBeLessThanOrEqual(MAX_SNAPSHOT_NOTE_SUMMARY_BYTES);
  });

  test("a review inside the budget publishes every note", () => {
    const files = [
      createTestBudgetFile([{ newRange: [8, 8], summary: "Sidecar", source: "ai" as const }]),
    ];
    const host = new ReviewSessionHost({ files, sourceLabel: "/repo", now: () => 1 });
    host.addLiveComment({ filePath: "src/alpha.ts", hunkIndex: 0, summary: "Live" }, "mcp:1");
    const state = host.getSessionSnapshotState();

    expect(state.liveComments.map((comment) => comment.commentId)).toEqual(["mcp:1"]);
    expect(state.reviewNotes.map((note) => note.source)).toEqual(["ai", "agent"]);
  });

  test("the joint budget leaves room under the daemon ceiling", () => {
    expect(MAX_SNAPSHOT_NOTE_SUMMARY_BYTES).toBeLessThanOrEqual(
      (DEFAULT_SESSION_BROKER_LIMITS.maxRetainedSessionBytes * 3) / 4,
    );
    // Without the joint bound the stored notes alone, listed twice, would not fit.
    expect(2 * MAX_REVIEW_NOTES_TOTAL_BYTES).toBeGreaterThan(MAX_SNAPSHOT_NOTE_SUMMARY_BYTES);
  });
});
