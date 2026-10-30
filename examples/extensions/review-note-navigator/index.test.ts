import { describe, expect, test } from "bun:test";
import type { ExtensionReviewSnapshot } from "hunkdiff/extension";
import {
  buildReviewNoteChoices,
  navigateToSavedReviewNote,
  selectedReviewNoteChoice,
} from "./index";

/** Build a frozen public snapshot with active, stale, and orphaned note shapes. */
function createTestSnapshot(): ExtensionReviewSnapshot {
  return Object.freeze({
    generation: "generation:test:1",
    stateRevision: 3,
    files: Object.freeze([
      Object.freeze({
        fileKey: "alpha-key",
        runtimeId: "runtime-alpha",
        path: "src/alpha.ts",
        changeKind: "change" as const,
        stats: Object.freeze({ additions: 2, deletions: 1, truncated: false }),
        flags: Object.freeze({
          untracked: false,
          binary: false,
          tooLarge: false,
          partial: false,
        }),
        contentIdentity: "sha256:alpha",
      }),
    ]),
    notes: Object.freeze([
      Object.freeze({
        id: "note:active",
        source: "user" as const,
        fileKey: "alpha-key",
        anchor: Object.freeze({
          preferred: Object.freeze({ side: "new" as const, line: 12 }),
          intersectingHunkIndices: Object.freeze([0]),
          ownerHunkIndex: 0,
        }),
        summary: "Check   the\nreturn value.",
        editable: true,
        resolution: "active" as const,
      }),
      Object.freeze({
        id: "note:stale",
        source: "agent" as const,
        fileKey: "alpha-key",
        anchor: Object.freeze({
          preferred: Object.freeze({ side: "old" as const, line: 8 }),
          intersectingHunkIndices: Object.freeze([0]),
          ownerHunkIndex: 0,
        }),
        summary: "Recheck after the refactor.",
        editable: false,
        resolution: "stale" as const,
      }),
      Object.freeze({
        id: "note:orphaned",
        source: "user" as const,
        fileKey: "retired-key",
        anchor: Object.freeze({ intersectingHunkIndices: Object.freeze([]) }),
        summary: "Keep the deleted fallback in mind.",
        editable: true,
        resolution: "orphaned" as const,
      }),
    ]),
  });
}

describe("review note navigator example", () => {
  test("labels every saved note in authoritative order with status and location", () => {
    expect(buildReviewNoteChoices(createTestSnapshot())).toEqual([
      {
        label: "1. [active] src/alpha.ts:12 (new) — Check the return value.",
        noteId: "note:active",
      },
      {
        label: "2. [stale] src/alpha.ts:8 (old) — Recheck after the refactor.",
        noteId: "note:stale",
      },
      {
        label: "3. [orphaned] retired file retired-key — Keep the deleted fallback in mind.",
        noteId: "note:orphaned",
      },
    ]);
  });

  test("keeps duplicate summaries selectable through unique ordinal labels", () => {
    const snapshot = createTestSnapshot();
    const choices = buildReviewNoteChoices({
      ...snapshot,
      notes: Object.freeze([
        snapshot.notes[0]!,
        Object.freeze({ ...snapshot.notes[0]!, id: "note:second" }),
      ]),
    });

    expect(new Set(choices.map((choice) => choice.label)).size).toBe(2);
    expect(choices.map((choice) => choice.noteId)).toEqual(["note:active", "note:second"]);
  });

  test("resolves the host-sanitized label through its stable ordinal", () => {
    const snapshot = createTestSnapshot();
    const choices = buildReviewNoteChoices({
      ...snapshot,
      files: Object.freeze([Object.freeze({ ...snapshot.files[0]!, path: "evil\u001b[31m.ts" })]),
    });

    expect(choices[0]!.label).toContain("\u001b[31m");
    expect(
      selectedReviewNoteChoice(choices, "1. [active] evil.ts:12 (new) — Check the return value.")
        ?.noteId,
    ).toBe("note:active");
    expect(selectedReviewNoteChoice(choices, "not an option")).toBeUndefined();
  });

  test("lands on the owner hunk when an expanded-gap line can no longer reveal exactly", () => {
    const snapshot = createTestSnapshot();
    const calls: string[] = [];

    const gapNote = {
      ...snapshot.notes[0]!,
      anchor: {
        ...snapshot.notes[0]!.anchor,
        intersectingHunkIndices: [],
        ownerHunkIndex: 0,
      },
    };

    navigateToSavedReviewNote(
      {
        selectFile: (fileId) => calls.push(`file:${fileId}`),
        selectHunk: (fileId, hunkIndex) => calls.push(`hunk:${fileId}:${hunkIndex}`),
        revealLine: (fileId, side, line) => calls.push(`line:${fileId}:${side}:${line}`),
      },
      snapshot.files[0]!,
      gapNote,
    );

    expect(calls).toEqual(["hunk:runtime-alpha:0", "line:runtime-alpha:new:12"]);
  });
});
