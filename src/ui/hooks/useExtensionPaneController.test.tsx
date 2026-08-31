import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useLayoutEffect, useState } from "react";
import type {
  ExtensionPaneAvailabilityContext,
  ExtensionPanePlacement,
  ExtensionPaneSize,
} from "../../extension-api/types";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import { createEmptyExtensionLoadResult, type RegisteredPane } from "../../extensions/types";
import {
  useExtensionPaneController,
  type ExtensionPaneController,
} from "./useExtensionPaneController";

interface TestPaneOptions {
  placement?: ExtensionPanePlacement;
  width?: ExtensionPaneSize;
  height?: ExtensionPaneSize;
  defaultOpen?: boolean;
  replaces?: string;
  currentLine?: boolean;
  available?: (context: ExtensionPaneAvailabilityContext) => boolean;
}

/** Build one test registration with observable pane policy and inert rendering. */
function registeredPane(
  extensionId: string,
  id: string,
  options: TestPaneOptions = {},
): RegisteredPane {
  return {
    extensionId,
    pane: {
      id,
      component: () => null,
      ...options,
    } as RegisteredPane["pane"],
  };
}

/** Build one mutable extension load result from pane registrations. */
function loadResultWith(panes: RegisteredPane[]) {
  const result = createEmptyExtensionLoadResult();
  result.registry.panes.push(...panes);
  return result;
}

/** Build the mouse fields consumed by pane resizing and record event ownership. */
function mouseEvent({ button = 0, x = 0, y = 0 }: { button?: number; x?: number; y?: number }) {
  let prevented = false;
  let stopped = false;
  return {
    event: {
      button,
      x,
      y,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    } as never,
    prevented: () => prevented,
    stopped: () => stopped,
  };
}

/** Mount a pane controller with mutable geometry, registration, and review inputs. */
async function renderController({
  extensions = loadResultWith([]),
  strictMode = false,
  initialResponsiveShowsSidebar = true,
  initialWidth = 100,
  initialHeight = 30,
  initialSidebar,
}: {
  extensions?: ReturnType<typeof createEmptyExtensionLoadResult>;
  strictMode?: boolean;
  initialResponsiveShowsSidebar?: boolean;
  initialWidth?: number;
  initialHeight?: number;
  initialSidebar?: boolean | "auto";
} = {}) {
  let controller!: ExtensionPaneController;
  let live = true;
  let setExtensions!: (value: ReturnType<typeof createEmptyExtensionLoadResult>) => void;
  let setCurrentLineCursor!: (value: { fileId: string; stableKey: string } | null) => void;
  let setResponsiveShowsSidebar!: (value: boolean) => void;
  let setSelectedFileId!: (value: string | null) => void;
  let setSize!: (value: { width: number; height: number }) => void;
  const committedFreshOpen: boolean[] = [];
  const warnings: string[] = [];
  const notifyWarning = (message: string) => warnings.push(message);
  const createReviewCapabilityLease = () => ({ isLive: () => live });
  const emptyFiles: ExtensionPaneAvailabilityContext["files"] = [];

  function Harness() {
    const [currentExtensions, updateExtensions] = useState(extensions);
    const [responsiveShowsSidebar, updateResponsiveShowsSidebar] = useState(
      initialResponsiveShowsSidebar,
    );
    const [currentLineCursor, updateCurrentLineCursor] = useState<{
      fileId: string;
      stableKey: string;
    } | null>(null);
    const [selectedFileId, updateSelectedFileId] = useState<string | null>(null);
    const [size, updateSize] = useState({ width: initialWidth, height: initialHeight });
    setCurrentLineCursor = updateCurrentLineCursor;
    setExtensions = updateExtensions;
    setResponsiveShowsSidebar = updateResponsiveShowsSidebar;
    setSelectedFileId = updateSelectedFileId;
    setSize = updateSize;
    controller = useExtensionPaneController({
      availabilityContext: { files: emptyFiles, selectedFileId, selectedHunkIndex: null },
      bodyHeight: size.height,
      bodyWidth: size.width,
      canForceShowSidebar: size.width >= 71,
      createReviewCapabilityLease,
      currentLineCursor,
      extensions: currentExtensions,
      initialSidebar,
      minReviewHeight: 5,
      minReviewWidth: 48,
      notifyWarning,
      pagerMode: false,
      responsiveShowsSidebar,
    });
    useLayoutEffect(() => {
      committedFreshOpen.push(controller.createPaneControls("meta").isOpen("fresh"));
    }, [currentExtensions]);
    return <text>{controller.paneLayout.panes.map(({ pane }) => pane.key).join(",")}</text>;
  }

  const setup = await testRender(
    strictMode ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    ),
    { width: initialWidth, height: initialHeight },
  );

  /** Flush commit-phase probes and any state they publish. */
  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
      await setup.renderOnce();
    });
  };
  await settle();

  return {
    committedFreshOpen,
    current: () => controller,
    retire: () => {
      live = false;
    },
    setCurrentLineCursor,
    setExtensions,
    setResponsiveShowsSidebar,
    setSelectedFileId,
    setSize,
    settle,
    setup,
    warnings,
  };
}

/** Destroy one controller harness. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

describe("useExtensionPaneController", () => {
  test("probes availability after commit and keeps false panes logically open", async () => {
    let available = false;
    let calls = 0;
    const pane = registeredPane("meta", "detail", {
      placement: "bottom",
      height: { preferred: 3, min: 3, max: 3 },
      defaultOpen: true,
      available: () => {
        calls += 1;
        return available;
      },
    });
    const harness = await renderController({
      extensions: loadResultWith([pane]),
      strictMode: true,
    });
    try {
      expect(calls).toBe(1);
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:detail"),
      ).toBeFalse();
      expect(harness.current().createPaneControls("meta").isOpen("detail")).toBeTrue();
      expect(harness.warnings).toEqual([]);

      available = true;
      await act(async () => harness.setSelectedFileId("next"));
      await harness.settle();
      expect(calls).toBe(2);
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:detail"),
      ).toBeTrue();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("quarantines one failed replacement, warns once, and restores a fresh registration", async () => {
    let calls = 0;
    const broken = registeredPane("meta", "files", {
      replaces: HUNK_FILES_PANE_KEY,
      available: () => {
        calls += 1;
        throw new Error("availability exploded");
      },
    });
    const harness = await renderController({
      extensions: loadResultWith([broken]),
      strictMode: true,
    });
    try {
      expect(calls).toBe(1);
      expect(harness.warnings).toEqual([
        'Extension meta pane "files" availability failed • availability exploded',
      ]);
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).toContain(
        HUNK_FILES_PANE_KEY,
      );

      await act(async () => harness.setSelectedFileId("changed"));
      await harness.settle();
      expect(calls).toBe(1);
      expect(harness.warnings).toHaveLength(1);

      const healthy = registeredPane("meta", "files", {
        replaces: HUNK_FILES_PANE_KEY,
        available: () => true,
      });
      await act(async () => harness.setExtensions(loadResultWith([healthy])));
      await harness.settle();
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).toContain(
        "meta:files",
      );
    } finally {
      await destroy(harness.setup);
    }
  });

  test("toggles off a built-in files fallback injected after an availability failure", async () => {
    const broken = registeredPane("meta", "files", {
      replaces: HUNK_FILES_PANE_KEY,
      available: () => {
        throw new Error("availability exploded");
      },
    });
    const harness = await renderController({ extensions: loadResultWith([broken]) });
    try {
      expect(harness.current().filesPaneVisible).toBeTrue();
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).toContain(
        HUNK_FILES_PANE_KEY,
      );

      await act(async () => harness.current().toggleFilesPane());
      await harness.settle();
      expect(harness.current().filesPaneVisible).toBeFalse();
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).not.toContain(
        HUNK_FILES_PANE_KEY,
      );

      await act(async () => harness.current().toggleFilesPane());
      await harness.settle();
      expect(harness.current().filesPaneVisible).toBeTrue();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("publishes newly registered default-open state before later layout effects run", async () => {
    const harness = await renderController();
    try {
      const fresh = registeredPane("meta", "fresh", {
        placement: "bottom",
        height: { preferred: 2, min: 2, max: 2 },
        defaultOpen: true,
      });
      await act(async () => harness.setExtensions(loadResultWith([fresh])));
      expect(harness.committedFreshOpen.at(-1)).toBeTrue();
      await harness.settle();
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).toContain(
        "meta:fresh",
      );
    } finally {
      await destroy(harness.setup);
    }
  });

  test("retires captured controls and reveals side panes only when an authorized action opens", async () => {
    const extra = registeredPane("meta", "extra", { defaultOpen: false });
    const harness = await renderController({
      extensions: loadResultWith([extra]),
      initialResponsiveShowsSidebar: false,
      initialSidebar: "auto",
    });
    try {
      const controls = harness.current().createPaneControls("meta");
      expect(harness.current().renderSidebar).toBeFalse();

      await act(async () => controls.open("extra"));
      await harness.settle();
      expect(harness.current().renderSidebar).toBeTrue();
      expect(controls.isOpen("extra")).toBeTrue();

      harness.retire();
      controls.close("extra");
      expect(controls.isOpen("extra")).toBeFalse();
      expect(harness.warnings.at(-1)).toContain("panes.close ignored");
    } finally {
      await destroy(harness.setup);
    }
  });

  test("falls back after a replacement render failure without retaining its logical open choice", async () => {
    const replacement = registeredPane("meta", "files", { replaces: HUNK_FILES_PANE_KEY });
    const harness = await renderController({ extensions: loadResultWith([replacement]) });
    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:files");
      expect(planned).toBeDefined();
      await act(async () => harness.current().reportPaneRenderFailure(planned!.pane));
      await harness.settle();
      expect(harness.current().paneLayout.panes.map(({ pane }) => pane.key)).toContain(
        HUNK_FILES_PANE_KEY,
      );
      expect(harness.current().createPaneControls("meta").isOpen("files")).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("retains an accepted current-line pane while replacement paint is pending", async () => {
    let calls = 0;
    const detail = registeredPane("meta", "line", {
      placement: "bottom",
      height: { preferred: 3, min: 3, max: 3 },
      defaultOpen: true,
      currentLine: true,
      available: ({ currentLine }) => {
        calls += 1;
        return currentLine !== null;
      },
    });
    const harness = await renderController({ extensions: loadResultWith([detail]) });
    try {
      expect(harness.current().currentLinePaintRequested).toBeTrue();
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:line"),
      ).toBeFalse();

      const paint = { side: "new" as const, line: 1, render: () => null };
      await act(async () => {
        harness.setCurrentLineCursor({ fileId: "file", stableKey: "cursor" });
        harness.current().onCurrentLinePaintChange({
          status: "ready",
          fileId: "file",
          cursorKey: "cursor",
          paint,
        });
      });
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:line"),
      ).toBeTrue();

      const callsBeforePending = calls;
      await act(async () => harness.current().onCurrentLinePaintChange({ status: "pending" }));
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:line"),
      ).toBeTrue();
      expect(calls).toBe(callsBeforePending);

      let replacementCalls = 0;
      const replacement = registeredPane("meta", "line", {
        placement: "bottom",
        height: { preferred: 3, min: 3, max: 3 },
        defaultOpen: true,
        currentLine: true,
        available: ({ currentLine }) => {
          replacementCalls += 1;
          expect(currentLine).toBeNull();
          return false;
        },
      });
      await act(async () => harness.setExtensions(loadResultWith([replacement])));
      await harness.settle();
      expect(replacementCalls).toBe(1);
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.registered === replacement),
      ).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("tracks responsive pane sizes until a drag establishes a restorable override", async () => {
    const right = registeredPane("meta", "right", {
      placement: "right",
      defaultOpen: true,
      width: { preferred: 20, min: 10, max: 50, fraction: 0.2 },
    });
    const harness = await renderController({
      extensions: loadResultWith([right]),
      initialSidebar: false,
    });
    const rightWidth = () =>
      harness.current().paneLayout.panes.find(({ pane }) => pane.key === "meta:right")!.bounds
        .width;

    try {
      expect(rightWidth()).toBe(20);
      await act(async () => harness.setSize({ width: 150, height: 30 }));
      await harness.settle();
      expect(rightWidth()).toBe(30);

      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:right")!;
      await act(async () => {
        harness.current().beginPaneResize(planned, mouseEvent({ x: planned.divider!.x }).event);
      });
      await act(async () => {
        harness.current().updatePaneResize(mouseEvent({ x: planned.divider!.x - 10 }).event);
      });
      await harness.settle();
      expect(rightWidth()).toBe(40);
      await act(async () => harness.current().endPaneResize());

      await act(async () => harness.setSize({ width: 80, height: 30 }));
      await harness.settle();
      expect(rightWidth()).toBe(31);
      await act(async () => harness.setSize({ width: 150, height: 30 }));
      await harness.settle();
      expect(rightWidth()).toBe(40);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not reinterpret a same-key width override after a pane moves to a row axis", async () => {
    const right = registeredPane("meta", "moving", {
      placement: "right",
      defaultOpen: true,
      width: { preferred: 20, min: 10, max: 50 },
    });
    const harness = await renderController({
      extensions: loadResultWith([right]),
      initialSidebar: false,
    });

    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:moving")!;
      await act(async () => {
        harness.current().beginPaneResize(planned, mouseEvent({ x: planned.divider!.x }).event);
        harness.current().updatePaneResize(mouseEvent({ x: planned.divider!.x - 10 }).event);
      });
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.find(({ pane }) => pane.key === "meta:moving")!.bounds
          .width,
      ).toBe(30);
      await act(async () => harness.current().endPaneResize());

      const bottom = registeredPane("meta", "moving", {
        placement: "bottom",
        defaultOpen: true,
        height: { preferred: 5, min: 3, max: 12 },
      });
      await act(async () => harness.setExtensions(loadResultWith([bottom])));
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.find(({ pane }) => pane.key === "meta:moving")!.bounds
          .height,
      ).toBe(5);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("resizes right panes with inverted drag direction and cancels after terminal shrink", async () => {
    const right = registeredPane("meta", "right", {
      placement: "right",
      defaultOpen: true,
      width: { preferred: 20, min: 10, max: 50 },
    });
    const harness = await renderController({
      extensions: loadResultWith([right]),
      initialSidebar: false,
    });
    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:right")!;
      const start = mouseEvent({ x: planned.divider!.x });
      let began = false;
      await act(async () => {
        began = harness.current().beginPaneResize(planned, start.event);
      });
      expect(began).toBeTrue();
      expect(start.prevented()).toBeTrue();
      const drag = mouseEvent({ x: planned.divider!.x - 8 });
      await act(async () => harness.current().updatePaneResize(drag.event));
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.find(({ pane }) => pane.key === "meta:right")!.bounds
          .width,
      ).toBe(planned.bounds.width + 8);

      await act(async () => harness.setSize({ width: 55, height: 30 }));
      await harness.settle();
      expect(harness.current().resizingPaneKey).toBeNull();
      const stale = mouseEvent({ x: 0 });
      harness.current().updatePaneResize(stale.event);
      expect(stale.prevented()).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("resizes bottom panes with inverted row-axis movement", async () => {
    const bottom = registeredPane("meta", "bottom", {
      placement: "bottom",
      defaultOpen: true,
      height: { preferred: 5, min: 3, max: 12 },
    });
    const harness = await renderController({
      extensions: loadResultWith([bottom]),
      initialSidebar: false,
    });
    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:bottom")!;
      const startHeight = planned.bounds.height;
      await act(async () => {
        harness.current().beginPaneResize(planned, mouseEvent({ y: planned.divider!.y }).event);
      });
      await act(async () => {
        harness.current().updatePaneResize(mouseEvent({ y: planned.divider!.y - 4 }).event);
      });
      await harness.settle();
      expect(
        harness.current().paneLayout.panes.find(({ pane }) => pane.key === "meta:bottom")!.bounds
          .height,
      ).toBe(startHeight + 4);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("cancels an active drag when controls close its pane", async () => {
    const extra = registeredPane("meta", "extra", {
      defaultOpen: true,
      width: { preferred: 24, min: 10, max: 40 },
    });
    const harness = await renderController({ extensions: loadResultWith([extra]) });
    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:extra")!;
      let began = false;
      await act(async () => {
        began = harness.current().beginPaneResize(planned, mouseEvent({ x: 24 }).event);
      });
      expect(began).toBeTrue();
      await harness.settle();
      expect(harness.current().resizingPaneKey).toBe("meta:extra");

      await act(async () => harness.current().createPaneControls("meta").close("extra"));
      await harness.settle();
      expect(harness.current().resizingPaneKey).toBeNull();
      expect(
        harness.current().paneLayout.panes.some(({ pane }) => pane.key === "meta:extra"),
      ).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("cancels a drag when a soft reload replaces the registration behind the same key", async () => {
    const first = registeredPane("meta", "extra", {
      defaultOpen: true,
      width: { preferred: 24, min: 10, max: 40 },
    });
    const harness = await renderController({ extensions: loadResultWith([first]) });
    try {
      const planned = harness
        .current()
        .paneLayout.panes.find(({ pane }) => pane.key === "meta:extra")!;
      await act(async () => {
        harness.current().beginPaneResize(planned, mouseEvent({ x: planned.divider!.x }).event);
      });
      await harness.settle();
      expect(harness.current().resizingPaneKey).toBe("meta:extra");

      const replacement = registeredPane("meta", "extra", {
        defaultOpen: true,
        width: { preferred: 24, min: 10, max: 40 },
      });
      await act(async () => harness.setExtensions(loadResultWith([replacement])));
      await harness.settle();
      expect(harness.current().resizingPaneKey).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });
});
