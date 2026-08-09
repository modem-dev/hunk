import { describe, expect, test } from "bun:test";
import { createTestReviewParityFixture } from "../../../test/helpers/review-content-helpers";
import { projectReviewDocument } from "./document";
import { buildReviewContentManifest } from "./contentManifest";

describe("review content manifest", () => {
  test("deterministically covers the renderer parity fixture without geometry", () => {
    const fixture = createTestReviewParityFixture();
    const first = buildReviewContentManifest(
      projectReviewDocument(fixture.changeset, fixture.projectionOptions),
    );
    const second = buildReviewContentManifest(
      projectReviewDocument(fixture.changeset, fixture.projectionOptions),
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.files.map((file) => file.path)).toEqual([
      "src/new-name.ts",
      "src/deleted.ts",
      "src/added.ts",
      "notes/untracked.txt",
      "assets/logo.bin",
      "generated/large.txt",
      "src/moved.ts",
    ]);
    expect(first.files.map((file) => file.changeKind)).toEqual([
      "rename-changed",
      "deleted",
      "new",
      "new",
      "change",
      "change",
      "change",
    ]);
    expect(first.files.find((file) => file.flags.untracked)?.path).toBe("notes/untracked.txt");
    expect(first.files.find((file) => file.flags.binary)?.path).toBe("assets/logo.bin");
    expect(first.files.find((file) => file.flags.tooLarge)?.path).toBe("generated/large.txt");

    const renamed = first.files[0]!;
    expect(renamed.notes.map((note) => [note.id, note.origin, note.source])).toEqual([
      ["old-note", "sidecar", "ai"],
      ["new-stml-note", "sidecar", "agent"],
      ["dual-note", "sidecar", "ai"],
      ["range-less-note", "sidecar", "ai"],
      ["live-note", "live-agent", "agent"],
      ["user-note", "user", "user"],
    ]);
    expect(renamed.notes.find((note) => note.id === "new-stml-note")?.markup).toContain("<strong>");
    expect(renamed.hunks[0]?.hunkContext).toBe("function renameValue()");
    expect(renamed.notes.find((note) => note.id === "range-less-note")?.anchor).toMatchObject({
      intersectingHunkIndices: [],
      ownerHunkIndex: 0,
    });

    const hunkless = first.files.find((file) => file.path === "assets/logo.bin")!;
    expect(hunkless.notes.find((note) => note.id === "hunkless-note")?.anchor).toEqual({
      intersectingHunkIndices: [],
    });

    const moved = first.files.at(-1)!;
    expect(moved.hunks.every((hunk) => hunk.splitLineCount > 0 && hunk.unifiedLineCount > 0)).toBe(
      true,
    );
    expect(moved.lineMoveKinds?.additionLines).toContain("moved");
    expect(moved.lineMoveKinds?.deletionLines).toContain("moved");
    expect(moved.expandedContext).toEqual([
      {
        gapId: "trailing:0",
        side: "new",
        oldRange: [3, 3],
        newRange: [3, 3],
        sourceText: "moved\nfirst\nlast\n",
      },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/geometry|width|height|terminal|splitRows|stackRows/);
  });

  test("ignores timestamp-like runtime changeset ids across equivalent reloads", () => {
    const fixture = createTestReviewParityFixture();
    const sourceIdentity = "test:stable-input";
    const first = buildReviewContentManifest(
      projectReviewDocument(fixture.changeset, { sourceIdentity }),
    );
    const second = buildReviewContentManifest(
      projectReviewDocument(
        {
          ...fixture.changeset,
          id: "reload:2099-12-31T23:59:59.999Z",
          files: fixture.changeset.files.map((file, index) => ({
            ...file,
            id: `reload-runtime-${index}`,
          })),
        },
        { sourceIdentity },
      ),
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(fixture.changeset.id);
  });
});
