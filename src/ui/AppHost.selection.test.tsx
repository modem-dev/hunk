import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { act } from "react";
import type { AppBootstrap } from "../core/types";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";

// These tests drive the DiffPane mouse-drag text-selection path end to end: begin/update/end
// copy-selection, double/triple-click word and line expansion, and the OSC 52 clipboard copy.
// They use the real @opentui render harness with synthetic mouse events, so the selection
// geometry runs against an actual rendered frame rather than a mocked layout.

/** Build a diff with many distinct changed rows so drags can span several review rows. */
function createSelectionBootstrap(): AppBootstrap {
  const before = Array.from(
    { length: 24 },
    (_, index) => `export const item${String(index + 1).padStart(2, "0")} = ${index + 1};`,
  );
  // Change every row so the review stream is dense with selectable changed code.
  const after = before.map((line, index) => line.replace(/= \d+;/, `= ${(index + 1) * 1000};`));

  return createTestVcsAppBootstrap({
    changesetId: "changeset:copy-selection",
    files: [
      createTestDiffFile({
        id: "selection",
        path: "selection.ts",
        before: lines(...before),
        after: lines(...after),
        context: 1,
      }),
    ],
    initialMode: "stack",
    initialCopyDecorations: true,
  });
}

/** Build a split-layout diff so the copy can resolve an old/new side from the drag column. */
function createSplitSelectionBootstrap(): AppBootstrap {
  const bootstrap = createSelectionBootstrap();
  return { ...bootstrap, initialMode: "split", input: { ...bootstrap.input } };
}

type Harness = Awaited<ReturnType<typeof testRender>>;

/** Settle pending renders so a frame reflects the latest interaction. */
async function flush(setup: Harness) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Poll rendered frames until `predicate` matches, resilient to async repaints. */
async function waitForFrame(setup: Harness, predicate: (frame: string) => boolean, attempts = 10) {
  let frame = setup.captureCharFrame();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate(frame)) {
      return frame;
    }
    await act(async () => {
      await Bun.sleep(20);
      await setup.renderOnce();
    });
    frame = setup.captureCharFrame();
  }
  return frame;
}

/** Find the screen position of the first occurrence of `needle` in the rendered frame. */
function locateText(frame: string, needle: string) {
  const rows = frame.split("\n");
  for (let y = 0; y < rows.length; y += 1) {
    const x = rows[y]?.indexOf(needle) ?? -1;
    if (x >= 0) {
      return { x, y };
    }
  }
  return null;
}

/**
 * Render the selection app and capture every OSC 52 clipboard write.
 *
 * `useRenderer()` inside DiffPane returns this same renderer instance, so forcing OSC 52 support
 * and spying on the copy method makes the clipboard side effect deterministic and observable.
 */
async function renderSelectionApp(
  bootstrap: AppBootstrap,
  {
    width = 110,
    height = 26,
    osc52 = true,
  }: { width?: number; height?: number; osc52?: boolean } = {},
) {
  const { AppHost } = await import("./AppHost");
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width, height });

  const copied: string[] = [];
  setup.renderer.isOsc52Supported = () => osc52;
  setup.renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text);
    return true;
  };

  await flush(setup);
  return { setup, copied };
}

describe("DiffPane copy selection", () => {
  test("dragging across changed rows copies the rendered selection to the clipboard", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const start = locateText(frame, "item01");
      const end = locateText(frame, "item05");
      expect(start).not.toBeNull();
      expect(end).not.toBeNull();

      await act(async () => {
        await setup.mockMouse.drag(start!.x + 2, start!.y, end!.x + 4, end!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      // The drag moved across rows, so release copies the rendered text and shows feedback.
      expect(copied.length).toBeGreaterThan(0);
      expect(copied.join("\n")).toContain("item");
      const noticeFrame = await waitForFrame(setup, (text) =>
        text.includes("Copied selection to clipboard"),
      );
      expect(noticeFrame).toContain("Copied selection to clipboard");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("double-clicking a token selects and copies the word under the pointer", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const target = locateText(frame, "item05");
      expect(target).not.toBeNull();

      await act(async () => {
        await setup.mockMouse.doubleClick(target!.x + 2, target!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(copied.length).toBeGreaterThan(0);
      // Word expansion copies a single contiguous token, not a whole multi-token line.
      expect(copied.some((text) => text.includes("item") && !text.includes(" "))).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("triple-clicking a row selects and copies the whole line", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const target = locateText(frame, "item06");
      expect(target).not.toBeNull();

      // Three rapid clicks at the same point escalate to a full-line selection.
      await act(async () => {
        await setup.mockMouse.click(target!.x + 2, target!.y, MouseButtons.LEFT);
        await setup.mockMouse.click(target!.x + 2, target!.y, MouseButtons.LEFT);
        await setup.mockMouse.click(target!.x + 2, target!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(copied.length).toBeGreaterThan(0);
      // Line expansion copies the full token sequence including the assignment.
      expect(copied.some((text) => text.includes("item06") && text.includes("="))).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a press and release without movement does not copy anything", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const target = locateText(frame, "item07");
      expect(target).not.toBeNull();

      await act(async () => {
        await setup.mockMouse.pressDown(target!.x + 2, target!.y, MouseButtons.LEFT);
      });
      await act(async () => {
        await setup.mockMouse.release(target!.x + 2, target!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      // endCopySelection returns early when the drag never moved, so nothing is copied.
      expect(copied.length).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("pressing outside the review viewport clears any pending selection", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      // Row 0 is the menu bar / top chrome, which resolves to no review-row point.
      await act(async () => {
        await setup.mockMouse.pressDown(40, 0, MouseButtons.LEFT);
      });
      await act(async () => {
        await setup.mockMouse.release(40, 0, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(copied.length).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a non-left mouse button never starts a selection", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const target = locateText(frame, "item04");
      expect(target).not.toBeNull();

      // Right-button drags belong to other handlers, so the copy-selection path bails immediately.
      await act(async () => {
        await setup.mockMouse.drag(
          target!.x + 2,
          target!.y,
          target!.x + 8,
          target!.y + 2,
          MouseButtons.RIGHT,
        );
      });
      await flush(setup);

      expect(copied.length).toBe(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a terminal without OSC 52 support reports that copying is unavailable", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap(), {
      osc52: false,
    });

    try {
      const frame = setup.captureCharFrame();
      const start = locateText(frame, "item02");
      const end = locateText(frame, "item06");
      expect(start).not.toBeNull();
      expect(end).not.toBeNull();

      await act(async () => {
        await setup.mockMouse.drag(start!.x + 2, start!.y, end!.x + 4, end!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      // The drag still resolves a selection, but the unsupported terminal falls back to a notice.
      expect(copied.length).toBe(0);
      const noticeFrame = await waitForFrame(setup, (text) => text.includes("Clipboard copy"));
      expect(noticeFrame).toContain("Clipboard copy");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("a drag starting on the pinned file header resolves a header selection point", async () => {
    const { setup, copied } = await renderSelectionApp(createSelectionBootstrap());

    try {
      const frame = setup.captureCharFrame();
      const header = locateText(frame, "selection.ts");
      const body = locateText(frame, "item06");
      expect(header).not.toBeNull();
      expect(body).not.toBeNull();

      // Begin the drag on the always-pinned header row, then move down into the diff body.
      await act(async () => {
        await setup.mockMouse.drag(
          header!.x + 2,
          header!.y,
          body!.x + 4,
          body!.y,
          MouseButtons.LEFT,
        );
      });
      await flush(setup);

      // Dragging from the pinned header into the body still produces a copied selection.
      expect(copied.length).toBeGreaterThan(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("dragging in split layout resolves a side and copies one column of code", async () => {
    const { setup, copied } = await renderSelectionApp(createSplitSelectionBootstrap(), {
      width: 160,
    });

    try {
      const frame = setup.captureCharFrame();
      const start = locateText(frame, "item01");
      const end = locateText(frame, "item03");
      expect(start).not.toBeNull();
      expect(end).not.toBeNull();

      await act(async () => {
        await setup.mockMouse.drag(start!.x + 2, start!.y, end!.x + 2, end!.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(copied.length).toBeGreaterThan(0);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
