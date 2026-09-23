import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRowComponentProps,
} from "../../../extension-api/types";
import {
  documentHighlightRunsForLine,
  loadDocumentHighlight,
} from "../../diff/documentHighlightService";
import { cursorLineHighlightBg } from "../../diff/rowStyle";
import { measureFileViewGeometry } from "../../fileViews/geometry";
import { validateFileViewLayout } from "../../fileViews/layout";
import { buildFileViewRenderPlan } from "../../fileViews/renderPlan";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";
import { createVisibleAgentNote } from "../../lib/agentAnnotations";
import { reviewRowId } from "../../lib/ids";
import { capturedTestColorToHex } from "../../../../../../test/helpers/test-color-helpers";
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

/** Return the captured foreground for the first terminal run containing text. */
function foregroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.fg)?.toLowerCase();
}

/** Return the captured background for the first terminal run containing text. */
function backgroundForText(
  capture: ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>,
  text: string,
) {
  const span = capture.lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.bg)?.toLowerCase();
}

/** Read the semantic text buffer below one host-owned row, independent of visual word wrapping. */
function rowPlainText(setup: Awaited<ReturnType<typeof testRender>>, rowId: string) {
  const row = setup.renderer.root.findDescendantById(reviewRowId(`file-view:${rowId}`));
  const pending = [...(row?.getChildren() ?? [])];
  while (pending.length > 0) {
    const candidate = pending.shift()!;
    if ("plainText" in candidate && typeof candidate.plainText === "string") {
      return candidate.plainText;
    }
    pending.push(...candidate.getChildren());
  }
  return undefined;
}

/** Return visible captured rows without terminal-width padding. */
function capturedLines(setup: Awaited<ReturnType<typeof testRender>>) {
  const lines = setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.at(-1) === "") lines.pop();
  return lines;
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

  test("paints syntax foregrounds without changing retained text, geometry, or row backgrounds", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const code = "const value = 42;";
    const file = createTestDiffFile({ id: "syntax", path: "syntax.ts" });
    const highlighted = await loadDocumentHighlight({
      text: code,
      path: file.path,
      language: "typescript",
      theme,
      offloadLargeDiff: false,
    });
    const syntaxForeground = documentHighlightRunsForLine(highlighted, 0).find((run) => run.fg)?.fg;
    expect(syntaxForeground).toBeDefined();

    const fileView = resolveTestLayout(
      {
        codeDocuments: [{ id: "code", text: code, language: "typescript" }],
        rows: [
          {
            id: "syntax-row",
            spans: [
              { text: "1 ", tone: "muted" },
              {
                text: code,
                tone: "removed",
                attributes: ["bold", "underline"],
                syntax: { documentId: "code", line: 1 },
              },
            ],
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      10,
    );
    const geometry = measureTestGeometry(fileView, 10);
    let enableHighlight = () => {};
    function Harness() {
      const [shouldLoadHighlight, setShouldLoadHighlight] = useState(false);
      enableHighlight = () => setShouldLoadHighlight(true);
      return (
        <FileView
          file={file}
          fileView={fileView}
          geometry={geometry}
          selectedHunkIndex={0}
          shouldLoadHighlight={shouldLoadHighlight}
          theme={theme}
          width={10}
        />
      );
    }

    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    await act(async () => {
      setup = await testRender(<Harness />, {
        width: 10,
        height: geometry.bodyHeight,
      });
      await setup.renderOnce();
    });
    await act(async () => {
      await setup!.renderOnce();
    });

    try {
      const plainFrame = setup!.captureCharFrame();
      const plainCapture = setup!.captureSpans();
      const plainHeight = setup!.renderer.root.findDescendantById(
        reviewRowId("file-view:syntax-row"),
      )?.height;
      expect(foregroundForText(plainCapture, "const")).toBe(theme.fileDeleted.toLowerCase());

      await act(async () => {
        enableHighlight();
        await setup!.renderOnce();
        await Bun.sleep(5);
      });
      await act(async () => {
        await setup!.renderOnce();
        await Bun.sleep(5);
      });
      const frame = setup!.captureCharFrame();
      const capture = setup!.captureSpans();
      expect(rowPlainText(setup!, "syntax-row")).toBe(`1 ${code}`);
      expect(frame).toBe(plainFrame);
      expect(
        setup!.renderer.root.findDescendantById(reviewRowId("file-view:syntax-row"))?.height,
      ).toBe(plainHeight);
      expect(plainHeight).toBe(geometry.rowBounds[0]?.height);
      expect(foregroundForText(capture, "1 ")).toBe(theme.muted.toLowerCase());
      expect(
        capture.lines
          .flatMap((line) => line.spans)
          .some(
            (span) =>
              capturedTestColorToHex(span.fg)?.toLowerCase() === syntaxForeground?.toLowerCase(),
          ),
      ).toBe(true);
      expect(backgroundForText(capture, "const")).toBe(theme.selectedHunk.toLowerCase());
      expect(
        capture.lines
          .flatMap((line) => line.spans)
          .filter((span) => /const|value|42/u.test(span.text))
          .every(
            (span) =>
              (span.attributes & (TextAttributes.BOLD | TextAttributes.UNDERLINE)) ===
              (TextAttributes.BOLD | TextAttributes.UNDERLINE),
          ),
      ).toBe(true);
    } finally {
      await act(async () => setup!.renderer.destroy());
    }
  });

  test("retains default word wrapping before and after syntax paint", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const text = "hello world";
    const file = createTestDiffFile({ id: "word-wrap", path: "word-wrap.ts" });
    await loadDocumentHighlight({
      text,
      path: file.path,
      language: "typescript",
      theme,
      offloadLargeDiff: false,
    });

    for (const syntax of [false, true]) {
      const fileView = resolveTestLayout(
        {
          ...(syntax ? { codeDocuments: [{ id: "code", text, language: "typescript" }] } : {}),
          rows: [
            {
              id: "word-row",
              spans: [syntax ? { text, syntax: { documentId: "code", line: 1 } } : { text }],
            },
          ],
          hunkRows: [{ startRow: 0, endRow: 0 }],
        },
        7,
      );
      const geometry = measureTestGeometry(fileView, 7);
      let setup: Awaited<ReturnType<typeof testRender>> | undefined;
      await act(async () => {
        setup = await testRender(
          <FileView
            file={file}
            fileView={fileView}
            geometry={geometry}
            selectedHunkIndex={0}
            shouldLoadHighlight={syntax}
            theme={theme}
            width={7}
          />,
          { width: 7, height: geometry.bodyHeight },
        );
        await setup.renderOnce();
      });
      try {
        await act(async () => {
          await setup!.renderOnce();
          await Bun.sleep(5);
        });
        await act(async () => setup!.renderOnce());
        expect(capturedLines(setup!)).toEqual(["hello", "world"]);
        expect(rowPlainText(setup!, "word-row")).toBe(text);
        expect(geometry.rowBounds[0]?.height).toBe(2);
        expect(
          setup!.renderer.root.findDescendantById(reviewRowId("file-view:word-row"))?.height,
        ).toBe(2);
      } finally {
        await act(async () => setup!.renderer.destroy());
      }
    }
  });

  test("matches native wrapping for unbroken wide text and following-row geometry", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createTestDiffFile({ id: "wide-wrap", path: "wide-wrap.ts" });
    const fileView = resolveTestLayout(
      {
        rows: [
          { id: "wide", spans: [{ text: "ab界界cd" }] },
          { id: "after-wide", spans: [{ text: "after" }] },
        ],
        hunkRows: [{ startRow: 0, endRow: 1 }],
      },
      4,
    );
    const geometry = measureTestGeometry(fileView, 4);
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    await act(async () => {
      setup = await testRender(
        <FileView
          file={file}
          fileView={fileView}
          geometry={geometry}
          selectedHunkIndex={0}
          theme={theme}
          width={4}
        />,
        { width: 4, height: geometry.bodyHeight },
      );
      await setup.renderOnce();
    });
    try {
      await act(async () => setup!.renderOnce());
      const wideRow = setup!.renderer.root.findDescendantById(reviewRowId("file-view:wide"));
      const followingRow = setup!.renderer.root.findDescendantById(
        reviewRowId("file-view:after-wide"),
      );
      expect(geometry.rowBounds[0]?.height).toBe(3);
      expect(geometry.rowBounds[1]?.top).toBe(3);
      expect(wideRow?.height).toBe(3);
      expect((followingRow?.y ?? -1) - (wideRow?.y ?? -1)).toBe(3);
    } finally {
      await act(async () => setup!.renderer.destroy());
    }
  });

  test("retains native fixed-width tabs across authored styles and wrap widths", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createTestDiffFile({ id: "tabs", path: "tabs.ts" });
    const cases = [
      { text: "a\tb", heights: [4, 3, 2, 1] },
      { text: "\t\t", heights: [4, 2, 2, 1] },
      { text: "\ta\t", heights: [5, 3, 2, 2] },
      { text: "a\t\tb", heights: [6, 4, 2, 2] },
    ].flatMap(({ text, heights }) =>
      heights.map((height, widthIndex) => ({ text, width: widthIndex + 1, height })),
    );

    for (const [index, input] of cases.entries()) {
      const spans = [...input.text].map((text, spanIndex) => ({
        text,
        tone: (["accent", "muted", "added"] as const)[spanIndex % 3],
      }));
      const fileView = resolveTestLayout(
        {
          rows: [
            { id: `tab-${index}`, spans },
            { id: `after-tab-${index}`, spans: [{ text: "z" }] },
          ],
          hunkRows: [{ startRow: 0, endRow: 1 }],
        },
        input.width,
      );
      const geometry = measureTestGeometry(fileView, input.width);
      let setup: Awaited<ReturnType<typeof testRender>> | undefined;
      await act(async () => {
        setup = await testRender(
          <FileView
            file={file}
            fileView={fileView}
            geometry={geometry}
            selectedHunkIndex={0}
            theme={theme}
            width={input.width}
          />,
          { width: input.width, height: geometry.bodyHeight },
        );
        await setup.renderOnce();
      });
      try {
        await act(async () => setup!.renderOnce());
        const row = setup!.renderer.root.findDescendantById(reviewRowId(`file-view:tab-${index}`));
        const following = setup!.renderer.root.findDescendantById(
          reviewRowId(`file-view:after-tab-${index}`),
        );
        expect(rowPlainText(setup!, `tab-${index}`)).toBe(input.text);
        if (index === 1) {
          const renderedTab = setup!.captureSpans().lines[1]?.spans[0];
          expect(renderedTab?.text).toBe("  ");
          expect(renderedTab?.width).toBe(2);
          expect(capturedTestColorToHex(renderedTab?.fg)?.toLowerCase()).toBe(
            theme.muted.toLowerCase(),
          );
        }
        expect(geometry.rowBounds[0]?.height).toBe(input.height);
        expect(geometry.rowBounds[1]?.top).toBe(input.height);
        expect(row?.height).toBe(input.height);
        expect((following?.y ?? -1) - (row?.y ?? -1)).toBe(input.height);
      } finally {
        await act(async () => setup!.renderer.destroy());
      }
    }
  });

  test("preserves graphemes split across final authored row spans", async () => {
    const cases = [
      { id: "surrogate", text: "😀", spans: ["\ud83d", "\ude00"] },
      { id: "combining", text: "é", spans: ["e", "́"] },
      { id: "variation", text: "❤️", spans: ["❤", "️"] },
      { id: "zwj", text: "👩‍💻", spans: ["👩", "‍", "💻"] },
    ];
    const theme = resolveTheme("github-dark-default", null);
    const file = createTestDiffFile({ id: "graphemes", path: "graphemes.ts" });
    await Promise.all(
      cases.map((input) =>
        loadDocumentHighlight({
          text: input.text,
          path: file.path,
          language: "typescript",
          theme,
          offloadLargeDiff: false,
        }),
      ),
    );
    const fileView = resolveTestLayout(
      {
        codeDocuments: cases.map((input) => ({
          id: input.id,
          text: input.text,
          language: "typescript",
        })),
        rows: cases.map((input) => {
          let offset = 0;
          return {
            id: input.id,
            spans: input.spans.map((text, index) => {
              const start = offset;
              offset += text.length;
              return {
                text,
                tone: index === 0 ? ("accent" as const) : ("removed" as const),
                syntax: {
                  documentId: input.id,
                  line: 1,
                  range: [start, offset] as const,
                },
              };
            }),
          };
        }),
        hunkRows: cases.map((_, index) => ({ startRow: index, endRow: index })),
      },
      4,
    );
    const geometry = measureTestGeometry(fileView, 4);
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    await act(async () => {
      setup = await testRender(
        <FileView
          file={file}
          fileView={fileView}
          geometry={geometry}
          selectedHunkIndex={0}
          shouldLoadHighlight
          theme={theme}
          width={4}
        />,
        { width: 4, height: geometry.bodyHeight },
      );
      await setup.renderOnce();
    });
    try {
      await act(async () => {
        await setup!.renderOnce();
        await Bun.sleep(5);
      });
      await act(async () => setup!.renderOnce());
      const frame = setup!.captureCharFrame();
      expect(frame).not.toContain("�");
      for (const [index, input] of cases.entries()) {
        expect(rowPlainText(setup!, input.id)).toBe(input.text);
        expect(frame).toContain(input.text);
        expect(geometry.rowBounds[index]?.height).toBe(1);
        expect(
          setup!.renderer.root.findDescendantById(reviewRowId(`file-view:${input.id}`))?.height,
        ).toBe(1);
      }
    } finally {
      await act(async () => setup!.renderer.destroy());
    }
  });

  test("paints two document slices independently and keeps the current-row background", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const file = createTestDiffFile({ id: "two-docs", path: "two-docs.ts" });
    const leftText = "const oldValue = 1;";
    const rightText = '"new text"';
    const [leftResult, rightResult] = await Promise.all([
      loadDocumentHighlight({
        text: leftText,
        path: file.path,
        language: "typescript",
        theme,
        offloadLargeDiff: false,
      }),
      loadDocumentHighlight({
        text: rightText,
        path: file.path,
        language: "typescript",
        theme,
        offloadLargeDiff: false,
      }),
    ]);
    const leftColor = documentHighlightRunsForLine(leftResult, 0).find(
      (run) => run.start === 0 && run.fg,
    )?.fg;
    const rightColor = documentHighlightRunsForLine(rightResult, 0).find(
      (run) => run.start <= 1 && run.end > 1 && run.fg,
    )?.fg;
    expect(leftColor).toBeDefined();
    expect(rightColor).toBeDefined();
    expect(leftColor).not.toBe(rightColor);

    const fileView = resolveTestLayout(
      {
        codeDocuments: [
          { id: "left", text: leftText, language: "typescript" },
          { id: "right", text: rightText, language: "typescript" },
        ],
        rows: [
          {
            id: "split",
            spans: [
              {
                text: "const",
                syntax: { documentId: "left", line: 1, range: [0, 5] },
              },
              { text: " | ", tone: "muted" },
              {
                text: "new text",
                syntax: { documentId: "right", line: 1, range: [1, 9] },
              },
            ],
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      30,
    );
    const geometry = measureTestGeometry(fileView, 30);
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    await act(async () => {
      setup = await testRender(
        <FileView
          file={file}
          fileView={fileView}
          geometry={geometry}
          cursorHighlight={{
            stableKey: "file-view:split",
            side: "new",
            style: "row",
          }}
          selectedHunkIndex={9}
          shouldLoadHighlight
          theme={theme}
          width={30}
        />,
        { width: 30, height: 1 },
      );
      await setup.renderOnce();
    });
    try {
      await act(async () => {
        await setup!.renderOnce();
        await Bun.sleep(5);
      });
      await act(async () => setup!.renderOnce());
      const capture = setup!.captureSpans();
      expect(foregroundForText(capture, "const")).toBe(leftColor?.toLowerCase());
      expect(foregroundForText(capture, "new text")).toBe(rightColor?.toLowerCase());
      expect(backgroundForText(capture, "const")).toBe(
        cursorLineHighlightBg(theme.panel, theme).toLowerCase(),
      );
      expect(backgroundForText(capture, "new text")).toBe(
        cursorLineHighlightBg(theme.panel, theme).toLowerCase(),
      );
    } finally {
      await act(async () => setup!.renderer.destroy());
    }
  });

  test("paints the same terminal-safe symbolic text that validation measured", async () => {
    const file = createTestDiffFile({ id: "safe", path: "safe.ts" });
    const fileView = resolveTestLayout(
      {
        rows: [
          {
            id: "unsafe",
            spans: [
              {
                text: "safe\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u0000",
              },
            ],
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      20,
    );
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
      { width: 20, height: 2 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(fileView.layout.rows[0]?.spans[0]?.text).toBe("safelink");
      expect(setup.captureCharFrame()).toContain("safelink");
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
        annotation: {
          id: "note",
          summary: "Review bound output",
          newRange: [1, 1],
        },
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
        theme: expect.objectContaining({
          appearance: "dark",
          text: expect.any(String),
        }),
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
              paints.push({
                appearance: theme.appearance,
                text: theme.text,
                token,
              });
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
    const file = createTestDiffFile({
      id: "stateful",
      path: "state.ts",
      before: "a",
      after: "b",
    });
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
          ? {
              sourceRanges: [{ side: "new" as const, range: [500, 500] as const }],
            }
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

  test("contains a component error while syntax-painting only its symbolic fallback", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const code = "const fallback = true;";
    const file = createTestDiffFile({
      id: "broken",
      path: "broken.ts",
      before: "a",
      after: "b",
    });
    const highlighted = await loadDocumentHighlight({
      text: code,
      path: file.path,
      language: "typescript",
      theme,
      offloadLargeDiff: false,
    });
    const syntaxForeground = documentHighlightRunsForLine(highlighted, 0).find((run) => run.fg)?.fg;
    expect(syntaxForeground).toBeDefined();
    const brokenLayout: ExtensionFileViewLayout = {
      codeDocuments: [{ id: "code", text: code, language: "typescript" }],
      rows: [
        {
          id: "broken",
          spans: [
            {
              text: code,
              tone: "removed",
              syntax: { documentId: "code", line: 1 },
            },
          ],
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
    const originalConsoleError = console.error;
    console.error = () => {};
    const failures: Array<{
      message: string;
      rowId: string;
      layoutGeneration: number;
    }> = [];
    const fileView = resolveTestLayout(brokenLayout, 20, 7);
    const setup = await testRender(
      <FileView
        file={file}
        fileView={fileView}
        geometry={measureTestGeometry(fileView, 20)}
        selectedHunkIndex={0}
        shouldLoadHighlight
        theme={theme}
        width={20}
        onRowFailure={(failure) => failures.push(failure)}
      />,
      { width: 20, height: 3 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(5);
      });
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(5);
      });
      expect(setup.captureCharFrame()).toContain("const fallback");
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) =>
              capturedTestColorToHex(span.fg)?.toLowerCase() === syntaxForeground?.toLowerCase(),
          ),
      ).toBe(true);
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
