import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createTestDiffFile } from "../../../../../../../test/helpers/diff-helpers";
import { resolveTheme } from "../../../../ui/themes";
import { toReadOnlyFileViews } from "../../../events";
import { FlexFileSidebar } from "./FileSidebars";

const FILE_COUNT = 40;
const FRAME_ROWS = 8;

const fileId = (index: number) => `file-${String(index).padStart(2, "0")}`;

const files = toReadOnlyFileViews(
  Array.from({ length: FILE_COUNT }, (_, index) =>
    createTestDiffFile({
      id: fileId(index),
      path: `src/${fileId(index)}.ts`,
      before: "export const value = 1;\n",
      after: "export const value = 2;\n",
    }),
  ),
);

interface SidebarSelectionHandle {
  select(id: string): void;
}

/** Host the bundled sidebar behind a selection setter so tests drive it like the review does. */
const SidebarSelectionHarness = forwardRef<SidebarSelectionHandle, { initialFileId: string }>(
  function SidebarSelectionHarness({ initialFileId }, ref) {
    const [selectedFileId, setSelectedFileId] = useState(initialFileId);
    useImperativeHandle(ref, () => ({ select: setSelectedFileId }), []);
    return (
      <FlexFileSidebar
        files={files}
        selectedFileId={selectedFileId}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={30}
        keybindings={{ matches: () => false, getKeys: () => [] }}
        actions={{
          copyText: () => false,
          selectFile: () => {},
          selectHunk: () => {},
          revealLine: () => {},
          notify: () => {},
        }}
      />
    );
  },
);

/** Return the sidebar row carrying the selected-file marker, if one is on screen. */
function selectedRow(frame: string) {
  return frame.split("\n").find((line) => line.includes("▌"));
}

async function renderSidebar(initialFileId: string) {
  const handle: { current: SidebarSelectionHandle | null } = { current: null };
  const setup = await testRender(
    <SidebarSelectionHarness
      ref={(value) => {
        handle.current = value;
      }}
      initialFileId={initialFileId}
    />,
    { width: 36, height: FRAME_ROWS },
  );
  await act(async () => {
    await setup.renderOnce();
  });

  /** Change the selection without letting a frame lay the new row out first. */
  const selectWithoutFrame = async (id: string) => {
    await act(async () => {
      handle.current?.select(id);
    });
  };

  /** Change the selection and let one frame settle, the way an unhurried key press does. */
  const selectAndSettle = async (id: string) => {
    await selectWithoutFrame(id);
    await act(async () => {
      await setup.renderOnce();
    });
  };

  const frame = async () => {
    await act(async () => {
      await setup.renderOnce();
    });
    return setup.captureCharFrame();
  };

  const destroy = async () => {
    await act(async () => {
      setup.renderer.destroy();
    });
  };

  return { selectWithoutFrame, selectAndSettle, frame, destroy };
}

describe("FlexFileSidebar selected-row reveal", () => {
  test("follows an unhurried walk down the list", async () => {
    const sidebar = await renderSidebar(fileId(0));
    try {
      for (let index = 1; index <= 12; index += 1) {
        await sidebar.selectAndSettle(fileId(index));
      }
      const frame = await sidebar.frame();
      expect(selectedRow(frame)).toContain(`${fileId(12)}.ts`);
      expect(frame).not.toContain(`${fileId(0)}.ts`);
    } finally {
      await sidebar.destroy();
    }
  });

  test("keeps following when selection outruns the laid-out rows", async () => {
    // Held-down file navigation lands several commits between two frames. Rows the render
    // window mounts for those commits have no layout yet, so a reveal that reads their
    // geometry either scrolls back to the top or does nothing.
    const sidebar = await renderSidebar(fileId(0));
    try {
      for (let index = 1; index <= 12; index += 1) {
        await sidebar.selectWithoutFrame(fileId(index));
      }
      const frame = await sidebar.frame();
      expect(selectedRow(frame)).toContain(`${fileId(12)}.ts`);
      expect(frame).not.toContain(`${fileId(0)}.ts`);
    } finally {
      await sidebar.destroy();
    }
  });

  test("does not scroll back to the top when a far row mounts fresh", async () => {
    const sidebar = await renderSidebar(fileId(0));
    try {
      for (let index = 1; index <= 20; index += 1) {
        await sidebar.selectAndSettle(fileId(index));
      }
      expect(selectedRow(await sidebar.frame())).toContain(`${fileId(20)}.ts`);

      await sidebar.selectWithoutFrame(fileId(30));
      const frame = await sidebar.frame();
      expect(selectedRow(frame)).toContain(`${fileId(30)}.ts`);
      expect(frame).not.toContain(`${fileId(0)}.ts`);

      // Stepping onward from the stuck state must keep revealing too.
      await sidebar.selectWithoutFrame(fileId(31));
      expect(selectedRow(await sidebar.frame())).toContain(`${fileId(31)}.ts`);
    } finally {
      await sidebar.destroy();
    }
  });

  test("reveals a selection that starts outside the first viewport", async () => {
    const sidebar = await renderSidebar(fileId(25));
    try {
      const frame = await sidebar.frame();
      expect(selectedRow(frame)).toContain(`${fileId(25)}.ts`);
    } finally {
      await sidebar.destroy();
    }
  });

  test("walks back up after the list has scrolled", async () => {
    const sidebar = await renderSidebar(fileId(0));
    try {
      for (let index = 1; index <= 20; index += 1) {
        await sidebar.selectAndSettle(fileId(index));
      }
      for (let index = 19; index >= 5; index -= 1) {
        await sidebar.selectWithoutFrame(fileId(index));
      }
      const frame = await sidebar.frame();
      expect(selectedRow(frame)).toContain(`${fileId(5)}.ts`);
    } finally {
      await sidebar.destroy();
    }
  });
});
