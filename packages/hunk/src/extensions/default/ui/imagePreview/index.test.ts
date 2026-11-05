import { describe, expect, test } from "bun:test";
import { createTestPng } from "../../../../../../../test/helpers/image-fixtures";
import { getBundledUIRegistry } from "..";
import { fileViewKey } from "../../../apply";
import type {
  ExtensionDiffFile,
  ExtensionFileSide,
  ExtensionFileViewInput,
} from "../../../../extension-api/types";
import { BUNDLED_IMAGE_PREVIEW_TOGGLE_COMMAND_ID, isPreviewableImagePath } from ".";

const BEFORE = createTestPng(24, 12, [40, 90, 220]);
const AFTER = createTestPng(32, 20, [40, 200, 90]);

/** Return the bundled image preview exactly as sessions receive it. */
function bundledImagePreview() {
  const registered = getBundledUIRegistry().fileViews.find(
    (entry) => fileViewKey(entry) === "hunk:image-preview",
  );
  if (!registered) throw new Error("image preview is not registered");
  return registered.view;
}

/** Build a public binary image file as the host hands it to file views. */
function createTestImageFile(overrides: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
  return {
    id: "file:icon",
    path: "assets/icon.png",
    patch: "Binary files a/assets/icon.png and b/assets/icon.png differ\n",
    stats: { additions: 0, deletions: 0 },
    metadata: {},
    changeType: "change",
    hunks: [],
    agent: null,
    isBinary: true,
    ...overrides,
  };
}

/** Build a layout request whose byte reads come from a fixed map, recording each read. */
function createTestImageInput(
  file: ExtensionDiffFile,
  sides: Partial<Record<ExtensionFileSide, Uint8Array>>,
) {
  const reads: ExtensionFileSide[] = [];
  const input: ExtensionFileViewInput = {
    file,
    width: 100,
    signal: new AbortController().signal,
    changes: [],
    readDocument: async () => null,
    readBytes: async (side) => {
      reads.push(side);
      return sides[side] ?? null;
    },
  };
  return { input, reads };
}

describe("bundled image preview", () => {
  test("is offered for binary images only", () => {
    const view = bundledImagePreview();

    expect(view.title).toBe("Image preview");
    expect(view.matches(createTestImageFile())).toBe(true);
    expect(view.matches(createTestImageFile({ path: "photo.JPEG" }))).toBe(true);
    expect(view.matches(createTestImageFile({ path: "logo.svg" }))).toBe(false);
    expect(view.matches(createTestImageFile({ isBinary: false }))).toBe(false);
    expect(isPreviewableImagePath("archive.tar.gz")).toBe(false);
  });

  test("draws both versions the review names, side by side", async () => {
    const { input, reads } = createTestImageInput(createTestImageFile(), {
      old: BEFORE,
      new: AFTER,
    });

    const layout = await bundledImagePreview().layout(input);

    expect(layout?.rows.map((row) => row.id)).toEqual(["summary", "captions", "images"]);
    expect(layout?.hunkRows).toEqual([]);
    expect(reads.sort()).toEqual(["new", "old"]);
  });

  test("never reads the side an added or deleted image does not have", async () => {
    const added = createTestImageInput(createTestImageFile({ changeType: "new" }), {
      new: AFTER,
    });
    const deleted = createTestImageInput(createTestImageFile({ changeType: "deleted" }), {
      old: BEFORE,
    });

    const addedLayout = await bundledImagePreview().layout(added.input);
    const deletedLayout = await bundledImagePreview().layout(deleted.input);

    expect(added.reads).toEqual(["new"]);
    expect(addedLayout?.rows[0]?.spans[0]?.text).toBe("Before · none, the image was added");
    expect(deleted.reads).toEqual(["old"]);
    expect(deletedLayout?.rows.at(-1)?.spans[0]?.text).toBe("After · none, the image was deleted");
  });

  test("declines, keeping the raw diff, when no side can be read or the file has text hunks", async () => {
    const unreadable = createTestImageInput(createTestImageFile(), {});
    const withHunks = createTestImageInput(
      createTestImageFile({ hunks: [{ index: 0, header: "@@ -1 +1 @@" }] as never }),
      { old: BEFORE, new: AFTER },
    );

    await expect(bundledImagePreview().layout(unreadable.input)).resolves.toBeNull();
    await expect(bundledImagePreview().layout(withHunks.input)).resolves.toBeNull();
    expect(withHunks.reads).toEqual([]);
  });

  test("binds a toggle command to i", () => {
    const command = getBundledUIRegistry().commands.find(
      (entry) => entry.command.id === BUNDLED_IMAGE_PREVIEW_TOGGLE_COMMAND_ID,
    );

    expect(command?.command).toMatchObject({ title: "Toggle image preview", key: "i" });
  });
});
