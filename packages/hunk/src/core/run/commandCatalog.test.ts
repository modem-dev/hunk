import { describe, expect, test } from "bun:test";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import {
  APP_COMMAND_CATALOG,
  appCommandCatalogEntry,
  lowerAppCommandToReviewIntent,
  type AppCommandCatalogEntry,
} from "./commandCatalog";

/** Look one entry up, failing loudly rather than silently skipping an assertion. */
function entry(id: string): AppCommandCatalogEntry {
  const found = appCommandCatalogEntry(id);
  if (!found) {
    throw new Error(`The catalog has no command ${id}.`);
  }
  return found;
}

describe("app command catalog", () => {
  test("gives every command one id under its own category", () => {
    const ids = APP_COMMAND_CATALOG.map((command) => command.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const command of APP_COMMAND_CATALOG) {
      expect(command.id.startsWith(`hunk.${command.category}.`)).toBe(true);
      expect(command.title.length).toBeGreaterThan(0);
    }
  });

  // Intent: the resolution locus is what tells a remote client whether it may invoke a
  // command at all, so only semantic commands may carry a review effect — and every one of
  // them carries one, so a semantic command added without an effect is caught here.
  test("keeps compatibility aliases unique and resolves them to canonical entries", () => {
    const canonicalIds = new Set(APP_COMMAND_CATALOG.map((command) => command.id));
    const aliases = APP_COMMAND_CATALOG.flatMap((command) => command.aliases ?? []);

    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases.filter((alias) => canonicalIds.has(alias))).toEqual([]);
    for (const command of APP_COMMAND_CATALOG) {
      for (const alias of command.aliases ?? []) {
        expect(appCommandCatalogEntry(alias)).toBe(command);
      }
    }
    expect(appCommandCatalogEntry("hunk.view.toggleSidebar")?.id).toBe("hunk.view.toggleFilesPane");
  });

  test("declares a review effect for semantic commands and nothing else", () => {
    const missingEffect = APP_COMMAND_CATALOG.filter(
      (command) => command.locus === "semantic" && command.review === undefined,
    ).map((command) => command.id);
    const strayEffect = APP_COMMAND_CATALOG.filter(
      (command) => command.locus !== "semantic" && command.review !== undefined,
    ).map((command) => command.id);

    expect(missingEffect).toEqual([]);
    expect(strayEffect).toEqual([]);
  });

  test("keeps host-only commands to the ones that must run where the review is hosted", () => {
    expect(
      APP_COMMAND_CATALOG.filter((command) => command.locus === "host-only").map(
        (command) => command.id,
      ),
    ).toEqual([
      "hunk.app.quit",
      "hunk.app.openAgentSkill",
      "hunk.app.refresh",
      "hunk.review.editSelectedFile",
    ]);
  });

  test("lowers navigation commands to the move their scope and direction declare", () => {
    const state = createTestReviewState();

    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.nextHunk"), { count: 1, state }),
    ).toEqual({ type: "selection/move", scope: "hunk", delta: 1 });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.previousHunk"), { count: 3, state }),
    ).toEqual({ type: "selection/move", scope: "hunk", delta: -3 });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.previousAnnotatedFile"), {
        count: 2,
        state,
      }),
    ).toEqual({ type: "selection/move", scope: "annotated-file", delta: -2 });
  });

  test("lowers the note-layer toggle against current review state", () => {
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.view.toggleAgentNotes"), {
        count: 1,
        state: createTestReviewState(),
      }),
    ).toEqual({ type: "notes/set-visibility", visible: true });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.view.toggleAgentNotes"), {
        count: 1,
        state: createTestReviewState(["alpha"], { showAgentNotes: true }),
      }),
    ).toEqual({ type: "notes/set-visibility", visible: false });
  });

  test("lowers nothing for commands that resolve outside the review model", () => {
    const state = createTestReviewState();

    expect(
      lowerAppCommandToReviewIntent(entry("hunk.view.toggleFilesPane"), { count: 1, state }),
    ).toBeUndefined();
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.app.quit"), { count: 1, state }),
    ).toBeUndefined();
  });

  test("lowers a new note at the current selection, with an optional measured line", () => {
    const state = createTestReviewState();

    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.startNote"), { count: 1, state }),
    ).toEqual({ type: "notes/start-draft", fileKey: "alpha", hunkIndex: 0 });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.startNote"), {
        count: 1,
        state,
        noteTarget: { side: "old", line: 4 },
      }),
    ).toEqual({
      type: "notes/start-draft",
      fileKey: "alpha",
      hunkIndex: 0,
      target: { side: "old", line: 4 },
    });
  });

  // Intent: an add-note affordance can address a row the reviewer is only pointing at, so
  // the client says where the note goes and the lowering falls back to the selection.
  test("lowers a new note at the location the client addressed", () => {
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.startNote"), {
        count: 1,
        state: createTestReviewState(["alpha", "beta"]),
        noteLocation: { fileKey: "beta", hunkIndex: 1 },
        noteTarget: { side: "new", line: 21 },
      }),
    ).toEqual({
      type: "notes/start-draft",
      fileKey: "beta",
      hunkIndex: 1,
      target: { side: "new", line: 21 },
    });
  });

  test("lowers edit and reply commands through the active-note policies", () => {
    const state = {
      ...createTestReviewState(["alpha"]),
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "user-1",
          parentId: "live-1",
          fileKey: "alpha",
          source: "user",
          editable: true,
        }),
      ],
    };

    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.editActiveNote"), { count: 1, state }),
    ).toEqual({ type: "notes/start-edit", noteId: "user-1" });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.replyToActiveNote"), { count: 1, state }),
    ).toEqual({ type: "notes/start-reply", noteId: "user-1" });
  });

  test("lowers the gap toggle to the gap the shared policy reaches", () => {
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.toggleHunkGap"), {
        count: 1,
        state: createTestReviewState([{ key: "alpha", sourceIdentity: "source:alpha" }]),
      }),
    ).toEqual({ type: "expansion/toggle", fileKey: "alpha", gapId: "before:1" });
  });

  // Intent: an effect with no target is a no-op everywhere rather than one client's guess.
  test("lowers nothing when a semantic effect has nothing to act on", () => {
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.toggleHunkGap"), {
        count: 1,
        state: createTestReviewState(),
      }),
    ).toBeUndefined();
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.startNote"), {
        count: 1,
        state: createTestReviewState([]),
      }),
    ).toBeUndefined();
  });
});
