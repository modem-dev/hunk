import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act, useEffect, useState } from "react";
import type { DiffFile } from "../src/core/types";
import { useReviewController, type ReviewController } from "../src/ui/hooks/useReviewController";

/** Build a minimal DiffFile with real parsed hunks and optional agent annotations. */
function createDiffFile(
  id: string,
  path: string,
  before: string,
  after: string,
  agent: DiffFile["agent"] = null,
): DiffFile {
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${id}:before` },
    { name: path, contents: after, cacheKey: `${id}:after` },
    { context: 3 },
    true,
  );

  let additions = 0;
  let deletions = 0;
  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return {
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions, deletions },
    metadata,
    agent,
  };
}

/** Build a stable multi-line string fixture. */
function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

/** Build one file with two hunks so selection clamping can be verified across reload-like updates. */
function createTwoHunkFile() {
  const beforeLines = Array.from(
    { length: 12 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[11] = "export const line12 = 1200;";

  return createDiffFile("alpha", "alpha.ts", lines(...beforeLines), lines(...afterLines));
}

/** Build the same file id with only one hunk so stale hunk indices must clamp. */
function createSingleHunkFile() {
  const beforeLines = Array.from(
    { length: 12 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";

  return createDiffFile("alpha", "alpha.ts", lines(...beforeLines), lines(...afterLines));
}

/** Let deferred filters and follow-up effects settle before reading controller state. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Assert one callback-populated test handle exists before using it. */
function expectValue<T>(value: T): NonNullable<T> {
  expect(value).toBeDefined();
  return value as NonNullable<T>;
}

function ReviewControllerHarness({
  initialFiles,
  onController,
  onSetFiles,
}: {
  initialFiles: DiffFile[];
  onController: (controller: ReviewController) => void;
  onSetFiles?: (setFiles: (nextFiles: DiffFile[]) => void) => void;
}) {
  const [files, setFiles] = useState(initialFiles);
  const controller = useReviewController({ files });

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  useEffect(() => {
    onSetFiles?.(setFiles);
  }, [onSetFiles]);

  return null;
}

describe("useReviewController", () => {
  test("reselects the first visible file when filtering hides the current selection", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[
          createDiffFile(
            "alpha",
            "alpha.ts",
            "export const alpha = 1;\n",
            "export const alpha = 2;\n",
          ),
          createDiffFile(
            "beta",
            "beta.ts",
            "export const beta = 1;\n",
            "export const betaValue = 2;\n",
          ),
        ]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("alpha.ts");

      await act(async () => {
        expectValue(controllerRef.current).setFilter("beta");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).visibleFiles.map((file) => file.path)).toEqual([
        "beta.ts",
      ]);
      expect(expectValue(controllerRef.current).selectedFileId).toBe("beta");
      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("beta.ts");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clamps the selected hunk index when files update under a soft reload", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setFilesRef: { current: ((nextFiles: DiffFile[]) => void) | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[createTwoHunkFile()]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
        onSetFiles={(nextSetFiles) => {
          setFilesRef.current = nextSetFiles;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(2);

      await act(async () => {
        expectValue(controllerRef.current).selectHunk("alpha", 1);
      });
      await flush(setup);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(1);

      await act(async () => {
        expectValue(setFilesRef.current)([createSingleHunkFile()]);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.metadata.hunks).toHaveLength(1);
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("live comment mutations update annotated navigation without remounting the app", async () => {
    const controllerRef: { current: ReviewController | null } = { current: null };
    const setup = await testRender(
      <ReviewControllerHarness
        initialFiles={[
          createDiffFile(
            "alpha",
            "alpha.ts",
            "export const alpha = 1;\n",
            "export const alpha = 2;\n",
          ),
          createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const beta = 2;\n"),
        ]}
        onController={(nextController) => {
          controllerRef.current = nextController;
        }}
      />,
      { width: 80, height: 4 },
    );

    try {
      await flush(setup);
      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);

      await act(async () => {
        expectValue(controllerRef.current).addLiveComment(
          {
            filePath: "beta.ts",
            side: "new",
            line: 1,
            summary: "Check beta rename",
          },
          "comment-1",
          { reveal: false },
        );
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(1);
      expect(expectValue(controllerRef.current).liveCommentSummaries).toHaveLength(1);
      expect(
        expectValue(controllerRef.current)
          .visibleFiles.find((file) => file.id === "beta")
          ?.agent?.annotations.map((annotation) => annotation.summary),
      ).toEqual(["Check beta rename"]);

      await act(async () => {
        expectValue(controllerRef.current).moveToAnnotatedHunk(1);
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).selectedFile?.path).toBe("beta.ts");
      expect(expectValue(controllerRef.current).selectedHunkIndex).toBe(0);
      expect(expectValue(controllerRef.current).scrollToNote).toBe(true);

      await act(async () => {
        expectValue(controllerRef.current).removeLiveComment("comment-1");
      });
      await flush(setup);

      expect(expectValue(controllerRef.current).liveCommentCount).toBe(0);
      expect(expectValue(controllerRef.current).liveCommentSummaries).toEqual([]);
      expect(
        expectValue(controllerRef.current).visibleFiles.find((file) => file.id === "beta")?.agent,
      ).toBeNull();
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
