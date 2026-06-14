import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { useReviewController } from "./useReviewController";

// These exercise the review navigation/selection behavior directly through the controller in a
// plain Solid reactive root — no terminal renderer, so they are immune to the OpenTUI yoga-layout
// process singleton that makes the full-app interaction tests pollute each other in a shared
// process. They cover the same fundamentals the AppHost interaction tests drive via key/mouse:
//   moveToFile  == the `.` / `,` file-jump shortcuts
//   moveToHunk  == the `]` / `[` hunk-navigation shortcuts (including crossing file boundaries)
//   selectHunk(preserveViewport) == the viewport-center selection that scrolling resolves to

/** A file whose before/after differ in two separated regions, yielding two hunks (context 0). */
function twoHunkFile(id: string, path: string) {
  const before = "a1\na2\na3\na4\na5\na6\na7\na8\n";
  const after = "CHANGED1\na2\na3\na4\na5\na6\na7\nCHANGED8\n";
  return createTestDiffFile({ id, path, before, after });
}

/** Run a controller in a disposable reactive root so its signals/memos work without a renderer. */
function withController<T>(
  files: ReturnType<typeof twoHunkFile>[],
  run: (c: ReturnType<typeof useReviewController>) => T,
): T {
  return createRoot((dispose) => {
    const controller = useReviewController({ files: () => files });
    try {
      return run(controller);
    } finally {
      dispose();
    }
  });
}

describe("review navigation (renderer-free)", () => {
  test("moveToFile jumps selection across visible files and wraps back", () => {
    const files = [twoHunkFile("first", "first.ts"), twoHunkFile("second", "second.ts")];
    withController(files, (c) => {
      expect(c.selectedFileId()).toBe("first");

      c.moveToFile(1);
      expect(c.selectedFileId()).toBe("second");
      // Landing on a new file selects its first hunk.
      expect(c.selectedHunkIndex()).toBe(0);

      c.moveToFile(-1);
      expect(c.selectedFileId()).toBe("first");
      expect(c.selectedHunkIndex()).toBe(0);
    });
  });

  test("moveToHunk steps through hunks and crosses into the next file at the boundary", () => {
    const files = [twoHunkFile("first", "first.ts"), twoHunkFile("second", "second.ts")];
    withController(files, (c) => {
      expect(c.selectedFileId()).toBe("first");
      expect(c.selectedHunkIndex()).toBe(0);

      // Second hunk of the first file.
      c.moveToHunk(1);
      expect(c.selectedFileId()).toBe("first");
      expect(c.selectedHunkIndex()).toBe(1);

      // Past the last hunk of the first file -> first hunk of the second file.
      c.moveToHunk(1);
      expect(c.selectedFileId()).toBe("second");
      expect(c.selectedHunkIndex()).toBe(0);

      // Backward across the boundary -> last hunk of the first file.
      c.moveToHunk(-1);
      expect(c.selectedFileId()).toBe("first");
      expect(c.selectedHunkIndex()).toBe(1);
    });
  });

  test("selectHunk updates the active file and hunk (viewport-center selection)", () => {
    const files = [twoHunkFile("first", "first.ts"), twoHunkFile("second", "second.ts")];
    withController(files, (c) => {
      // What the DiffPane viewport-center tracker calls when scrolling lands on a later hunk.
      c.selectHunk("second", 1, { preserveViewport: true });
      expect(c.selectedFileId()).toBe("second");
      expect(c.selectedHunkIndex()).toBe(1);
      expect(c.selectedFile()?.path).toBe("second.ts");

      c.selectHunk("first", 0, { preserveViewport: true });
      expect(c.selectedFileId()).toBe("first");
      expect(c.selectedHunkIndex()).toBe(0);
    });
  });
});
