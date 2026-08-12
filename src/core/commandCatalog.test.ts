import { describe, expect, test } from "bun:test";
import {
  APP_COMMAND_CATALOG,
  appCommandCatalogEntry,
  lowerAppCommandToReviewIntent,
  SEMANTIC_COMMANDS_WITHOUT_REVIEW_EFFECT,
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
  // command at all, so only semantic commands may carry a review effect.
  test("declares a review effect for semantic commands and nothing else", () => {
    const missingEffect = APP_COMMAND_CATALOG.filter(
      (command) => command.locus === "semantic" && command.review === undefined,
    ).map((command) => command.id);
    const strayEffect = APP_COMMAND_CATALOG.filter(
      (command) => command.locus !== "semantic" && command.review !== undefined,
    ).map((command) => command.id);

    expect(missingEffect).toEqual([...SEMANTIC_COMMANDS_WITHOUT_REVIEW_EFFECT]);
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
    const state = { showAgentNotes: false };

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
        state: { showAgentNotes: false },
      }),
    ).toEqual({ type: "notes/set-visibility", visible: true });
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.view.toggleAgentNotes"), {
        count: 1,
        state: { showAgentNotes: true },
      }),
    ).toEqual({ type: "notes/set-visibility", visible: false });
  });

  test("lowers nothing for commands that resolve outside the review model", () => {
    const state = { showAgentNotes: false };

    expect(
      lowerAppCommandToReviewIntent(entry("hunk.view.toggleSidebar"), { count: 1, state }),
    ).toBeUndefined();
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.app.quit"), { count: 1, state }),
    ).toBeUndefined();
    expect(
      lowerAppCommandToReviewIntent(entry("hunk.review.toggleHunkGap"), { count: 1, state }),
    ).toBeUndefined();
  });
});
