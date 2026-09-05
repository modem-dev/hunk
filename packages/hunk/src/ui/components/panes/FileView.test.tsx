import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRowComponentProps,
} from "../../../extension-api/types";
import { measureFileViewGeometry } from "../../fileViews/geometry";
import { validateFileViewLayout } from "../../fileViews/layout";
import { buildFileViewRenderPlan } from "../../fileViews/renderPlan";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";
import { createVisibleAgentNote } from "../../lib/agentAnnotations";
import { reviewRowId } from "../../lib/ids";
import { resolveTheme } from "../../themes";
import { FileView, isFileViewRowSelected } from "./FileView";

/** Validate a test layout and add the host identity carried by accepted runtime layouts. */
function resolveTestLayout(
  layout: ExtensionFileViewLayout,
  width: number,
  generation = 1,
): ResolvedFileViewLayout {
  const checked = validateFileViewLayout(layout, layout.hunkRows.length, width);
  if (!checked.valid) throw new Error(checked.issue);
  return {
    ...checked.value,
    key: "test:view",
    extensionId: "test",
    viewId: "view",
    registrationIdentity: 1,
    layoutGeneration: generation,
  };
}

/** Measure a note-less presentation at one explicit content width. */
function measureTestGeometry(fileView: ResolvedFileViewLayout, width: number) {
  return measureFileViewGeometry({
    resolved: fileView,
    plannedRows: buildFileViewRenderPlan(fileView.layout, []).rows,
    width,
  });
}

const layout: ExtensionFileViewLayout = {
  rows: [
    { id: "heading", spans: [{ text: "Heading" }] },
    { id: "body", spans: [{ text: "Body" }] },
    { id: "tail", spans: [{ text: "Tail" }] },
  ],
  hunkRows: [
    { startRow: 0, endRow: 0 },
    { startRow: 0, endRow: 0 },
    { startRow: 1, endRow: 2 },
  ],
};

describe("FileView hunk selection", () => {
  test("highlights every rendered row inside the selected hunk bounds", () => {
    expect(isFileViewRowSelected(layout, 0, 2)).toBe(false);
    expect(isFileViewRowSelected(layout, 1, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 2, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 1, 1)).toBe(false);
  });
});

describe("FileView custom rows", () => {
  test("preserves the symbolic-only renderer", async () => {
    const file = createTestDiffFile({
      id: "symbolic",
      path: "symbolic.ts",
      before: "a",
      after: "b",
    });
    const fileView = resolveTestLayout(layout, 20);
    const geometry = measureTestGeometry(fileView, 20);
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={geometry}
        selectedHunkIndex={2}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
      />,
      { width: 20, height: 4 },
    );

    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Heading");
      expect(frame).toContain("Body");
      expect(frame).toContain("Tail");
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:body"))?.height).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("renders a host-owned note immediately after its bound alternate row", async () => {
    const file = createTestDiffFile({ id: "noted", path: "noted.ts" });
    const fileView = resolveTestLayout(
      {
        rows: [
          {
            id: "bound",
            spans: [{ text: "BOUND PRESENTATION" }],
            sourceRanges: [{ side: "new", range: [1, 2] }],
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      60,
    );
    const plan = buildFileViewRenderPlan(fileView.layout, [
      createVisibleAgentNote([], {
        id: "note",
        annotation: { id: "note", summary: "Review bound output", newRange: [1, 1] },
      }),
    ]);
    const geometry = measureFileViewGeometry({
      resolved: fileView,
      plannedRows: plan.rows,
      width: 60,
    });
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={60}
      />,
      { width: 60, height: geometry.bodyHeight },
    );

    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Review bound output");
      expect(frame).toContain("BOUND PRESENTATION");
      expect(frame.indexOf("Review bound output")).toBeGreaterThan(
        frame.indexOf("BOUND PRESENTATION"),
      );
      expect(
        setup.renderer.root.findDescendantById(reviewRowId("inline-note:note:file-view:bound:0")),
      ).not.toBeNull();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mounts hook-using components only inside the host row window with bounded props", async () => {
    const paintProps: ExtensionFileViewRowComponentProps[] = [];
    const customRow = (label: string) =>
      function CustomRow(props: ExtensionFileViewRowComponentProps) {
        const [captured] = useState(label);
        paintProps.push(props);
        return <text content={`CUSTOM ${captured}`} />;
      };
    const customLayout: ExtensionFileViewLayout = {
      rows: [
        { id: "before", spans: [{ text: "BEFORE" }] },
        {
          id: "custom-a",
          spans: [{ text: "FALLBACK A" }],
          component: { height: 2, render: customRow("A") },
        },
        {
          id: "custom-b",
          spans: [{ text: "FALLBACK B" }],
          component: { height: 2, render: customRow("B") },
        },
      ],
      hunkRows: [
        { startRow: 1, endRow: 1 },
        { startRow: 2, endRow: 2 },
      ],
    };
    const file = createTestDiffFile({
      id: "custom",
      path: "custom.ts",
      before: "a",
      after: "b",
    });
    const fileView = resolveTestLayout(customLayout, 20);
    const geometry = measureTestGeometry(fileView, 20);
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        visibleBodyBounds={{ top: 1, height: 2 }}
        width={20}
      />,
      { width: 20, height: 5 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("CUSTOM A");
      expect(frame).not.toContain("CUSTOM B");
      expect(frame).not.toContain("BEFORE");
      expect(paintProps.at(-1)).toEqual({
        width: 20,
        height: 2,
        selected: true,
        rowIndex: 1,
        theme: expect.objectContaining({ appearance: "dark", text: expect.any(String) }),
      });
      expect(Object.isFrozen(paintProps.at(-1)?.theme)).toBe(true);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("repaints live semantic theme props without remounting or relayout", async () => {
    let mountSequence = 0;
    const paints: Array<{ appearance: string; text: string; token: number }> = [];
    const themedLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "themed",
          spans: [{ text: "fallback" }],
          component: {
            height: 1,
            render: ({ theme }) => {
              const [token] = useState(() => ++mountSequence);
              paints.push({ appearance: theme.appearance, text: theme.text, token });
              return <text content={`${theme.appearance} ${token}`} style={{ fg: theme.text }} />;
            },
          },
        },
      ],
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const file = createTestDiffFile({ id: "themed", path: "themed.ts" });
    const fileView = resolveTestLayout(themedLayout, 20);
    const geometry = measureTestGeometry(fileView, 20);
    let switchTheme = () => {};

    function Harness() {
      const [themeId, setThemeId] = useState("github-dark-default");
      switchTheme = () => setThemeId("github-light-default");
      return (
        <FileView
          file={file}
          fileView={fileView}
          geometry={geometry}
          selectedHunkIndex={0}
          theme={resolveTheme(themeId, null)}
          width={20}
        />
      );
    }

    const setup = await testRender(<Harness />, { width: 20, height: 2 });
    try {
      await act(async () => setup.renderOnce());
      expect(paints.at(-1)).toMatchObject({ appearance: "dark", token: 1 });
      const darkText = paints.at(-1)?.text;

      await act(async () => {
        switchTheme();
        await setup.renderOnce();
      });
      expect(paints.at(-1)).toMatchObject({ appearance: "light", token: 1 });
      expect(paints.at(-1)?.text).not.toBe(darkText);
      expect(fileView.layoutGeneration).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("retains ephemeral hook state across selection props but loses it on unmount and generation", async () => {
    let mountSequence = 0;
    const renders: Array<{ selected: boolean; token: number }> = [];
    const statefulLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "stateful",
          spans: [{ text: "fallback" }],
          component: {
            height: 1,
            render: ({ selected }) => {
              const [token] = useState(() => ++mountSequence);
              renders.push({ selected, token });
              return <text content={`state ${token}`} />;
            },
          },
        },
      ],
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const file = createTestDiffFile({ id: "stateful", path: "state.ts", before: "a", after: "b" });
    const initial = resolveTestLayout(statefulLayout, 20);
    let selectHunk: (index: number) => void = () => {};
    let showRow: (visible: boolean) => void = () => {};
    let replaceGeneration: () => void = () => {};

    function Harness() {
      const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
      const [visible, setVisible] = useState(true);
      const [fileView, setFileView] = useState(initial);
      selectHunk = setSelectedHunkIndex;
      showRow = setVisible;
      replaceGeneration = () =>
        setFileView((current) => ({
          ...current,
          layoutGeneration: current.layoutGeneration + 1,
        }));
      return (
        <FileView
          file={file}
          fileView={fileView}
          geometry={measureTestGeometry(fileView, 20)}
          selectedHunkIndex={selectedHunkIndex}
          theme={resolveTheme("github-dark-default", null)}
          visibleBodyBounds={visible ? { top: 0, height: 1 } : { top: 1, height: 0 }}
          width={20}
        />
      );
    }

    const setup = await testRender(<Harness />, { width: 20, height: 2 });
    try {
      await act(async () => setup.renderOnce());
      expect(renders.at(-1)).toEqual({ selected: true, token: 1 });

      await act(async () => {
        selectHunk(-1);
        await setup.renderOnce();
      });
      expect(renders.at(-1)).toEqual({ selected: false, token: 1 });

      await act(async () => {
        showRow(false);
        await setup.renderOnce();
      });
      await act(async () => {
        showRow(true);
        await setup.renderOnce();
      });
      expect(renders.at(-1)?.token).toBe(2);

      await act(async () => {
        replaceGeneration();
        await setup.renderOnce();
      });
      expect(renders.at(-1)?.token).toBe(3);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mounts only visible painters from a 1,000-row component layout", async () => {
    const mounted: number[] = [];
    const largeLayout: ExtensionFileViewLayout = {
      rows: Array.from({ length: 1_000 }, (_, index) => ({
        id: `row-${index}`,
        spans: [{ text: `fallback ${index}` }],
        ...(index === 500
          ? { sourceRanges: [{ side: "new" as const, range: [500, 500] as const }] }
          : {}),
        component: {
          height: 1,
          render: () => {
            mounted.push(index);
            return <text content={`paint ${index}`} />;
          },
        },
      })),
      hunkRows: [{ startRow: 0, endRow: 999 }],
    };
    const file = createTestDiffFile({
      id: "large",
      path: "large.ts",
      before: "a",
      after: "b",
    });
    const fileView = resolveTestLayout(largeLayout, 20);
    const plan = buildFileViewRenderPlan(fileView.layout, [
      createVisibleAgentNote([], {
        id: "windowed-note",
        annotation: { summary: "WINDOWED NOTE", newRange: [500, 500] },
      }),
    ]);
    const geometry = measureFileViewGeometry({
      resolved: fileView,
      plannedRows: plan.rows,
      width: 20,
    });
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        visibleBodyBounds={{ top: 500, height: 8 }}
        width={20}
      />,
      { width: 20, height: 8 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(
        setup.renderer.root.findDescendantById(
          reviewRowId("inline-note:windowed-note:file-view:row-500:0"),
        ),
      ).not.toBeNull();
      expect(new Set(mounted)).toEqual(new Set([500, 501, 502, 503]));
      expect(mounted).not.toContain(499);
      expect(mounted).not.toContain(504);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("clips oversized custom output to fixed host geometry and retains stable row ids", async () => {
    const clippedLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "clipped",
          spans: [{ text: "CLIPPED FALLBACK" }],
          component: {
            height: 1,
            render: () => (
              <box style={{ width: 40, height: 3, flexDirection: "column" }}>
                <text content="VISIBLE CUSTOM" />
                <text content="HIDDEN OVERFLOW" />
                <text content="HIDDEN OVERFLOW" />
              </box>
            ),
          },
        },
        { id: "after", spans: [{ text: "AFTER ROW" }] },
      ],
      hunkRows: [{ startRow: 0, endRow: 1 }],
    };
    const file = createTestDiffFile({
      id: "clipped",
      path: "clipped.ts",
      before: "a",
      after: "b",
    });
    const fileView = resolveTestLayout(clippedLayout, 20);
    const geometry = measureTestGeometry(fileView, 20);
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
      />,
      { width: 20, height: 3 },
    );

    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("VISIBLE CUSTOM");
      expect(frame).not.toContain("HIDDEN OVERFLOW");
      expect(frame.split("\n")[1]).toContain("AFTER ROW");
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:clipped"))?.height).toBe(
        1,
      );
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:after"))?.height).toBe(
        1,
      );
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("contains a component render error to its symbolic row fallback", async () => {
    const brokenLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "broken",
          spans: [{ text: "SAFE FALLBACK" }],
          component: {
            height: 2,
            render: () => {
              throw new Error("broken custom row");
            },
          },
        },
      ],
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const file = createTestDiffFile({
      id: "broken",
      path: "broken.ts",
      before: "a",
      after: "b",
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    const failures: Array<{ message: string; rowId: string; layoutGeneration: number }> = [];
    const fileView = resolveTestLayout(brokenLayout, 20, 7);
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={measureTestGeometry(fileView, 20)}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
        onRowFailure={(failure) => failures.push(failure)}
      />,
      { width: 20, height: 3 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("SAFE FALLBACK");
      expect(failures).toEqual([
        expect.objectContaining({
          message: "broken custom row",
          rowId: "broken",
          layoutGeneration: 7,
        }),
      ]);
    } finally {
      console.error = originalConsoleError;
      await act(async () => setup.renderer.destroy());
    }
  });
});
