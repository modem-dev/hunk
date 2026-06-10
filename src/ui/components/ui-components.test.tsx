import { describe, expect, mock, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, createRef, useEffect, useState, type ReactNode } from "react";
import type { AppBootstrap, DiffFile } from "../../core/types";
import { createTestVcsAppBootstrap } from "../../../test/helpers/app-bootstrap";
import { capturedTestColorToHex } from "../../../test/helpers/test-color-helpers";
import {
  createTestDiffFile as buildTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { hexColorDistance } from "../lib/color";
import { resolveTheme } from "../themes";
import { measureDiffSectionGeometry } from "../diff/diffSectionGeometry";
import { buildFileSectionLayouts, buildInStreamFileHeaderHeights } from "../lib/fileSectionLayout";

const { AppHost } = await import("../AppHost");
const { buildSidebarEntries } = await import("../lib/files");
const { HelpDialog } = await import("./chrome/HelpDialog");
const { SidebarPane } = await import("./panes/SidebarPane");
const { AgentCard } = await import("./panes/AgentCard");
const { AgentInlineNote } = await import("./panes/AgentInlineNote");
const { DiffPane } = await import("./panes/DiffPane");
const { MenuDropdown } = await import("./chrome/MenuDropdown");
const { StatusBar } = await import("./chrome/StatusBar");
const { DiffSectionPlaceholder } = await import("./panes/DiffSectionPlaceholder");
const { DiffFileHeaderRow } = await import("./panes/DiffFileHeaderRow");
const { PierreDiffView } = await import("../diff/PierreDiffView");
const { DiffRowView } = await import("../diff/renderRows");

function createTestDiffFile(
  id: string,
  path: string,
  before: string,
  after: string,
  withAgent = false,
): DiffFile {
  return buildTestDiffFile({
    after,
    agent: withAgent
      ? {
          annotations: [
            {
              confidence: "high",
              newRange: [2, 2],
              rationale: `Why ${path} changed`,
              summary: `Annotation for ${path}`,
              tags: ["review"],
            },
          ],
          path,
          summary: `${path} note`,
        }
      : null,
    before,
    context: 3,
    id,
    path,
  });
}

function createWindowingFiles(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createTestDiffFile(
      `window-${index + 1}`,
      `window-${index + 1}.ts`,
      lines(`export const file${index + 1} = ${index + 1};`),
      lines(
        `export const file${index + 1} = ${index + 10};`,
        `export const file${index + 1}Extra = true;`,
      ),
    ),
  );
}

function createHighlightPrefetchWindowFiles() {
  return Array.from({ length: 4 }, (_, index) => {
    const marker = `prefetchMarker${index + 1}`;
    const before = lines(
      `export const ${marker} = ${index + 1};`,
      ...Array.from(
        { length: 8 },
        (_, lineIndex) =>
          `export function keep${index + 1}_${lineIndex}(value: number) { return value + ${lineIndex}; }`,
      ),
    );
    const after = lines(
      `export const ${marker} = ${index + 100};`,
      ...Array.from(
        { length: 8 },
        (_, lineIndex) =>
          `export function keep${index + 1}_${lineIndex}(value: number) { return value * ${lineIndex + 2}; }`,
      ),
    );

    return createTestDiffFile(`prefetch-${index + 1}`, `prefetch-${index + 1}.ts`, before, after);
  });
}

function createMultiHunkDiffFile(id: string, path: string) {
  const before = lines(
    "export const line1 = 1;",
    "export const line2 = 2;",
    "export const line3 = 3;",
    "export const line4 = 4;",
    "export const line5 = 5;",
    "export const line6 = 6;",
    "export const line7 = 7;",
    "export const line8 = 8;",
    "export const line9 = 9;",
    "export const line10 = 10;",
    "export const line11 = 11;",
    "export const line12 = 12;",
  );
  const after = lines(
    "export const line1 = 1;",
    "export const line2 = 200;",
    "export const line3 = 3;",
    "export const line4 = 4;",
    "export const line5 = 5;",
    "export const line6 = 6;",
    "export const line7 = 7;",
    "export const line8 = 8;",
    "export const line9 = 9;",
    "export const line10 = 10;",
    "export const line11 = 1100;",
    "export const line12 = 12;",
  );

  return createTestDiffFile(id, path, before, after);
}

/** Build one tall file with two distant changed lines so the diff parser produces two hunks. */
function createWideTwoHunkDiffFile(id: string, path: string, start = 1) {
  const beforeLines = Array.from(
    { length: 80 },
    (_, index) => `export const line${start + index} = ${start + index};`,
  );
  const afterLines = [...beforeLines];

  afterLines[0] = `export const line${start} = ${start + 1000};`;
  afterLines[59] = `export const line${start + 59} = ${start + 5900};`;

  return createTestDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
}

/** Convert one desired viewport-center offset into the scrollTop that centers it on screen. */
function scrollTopForCenter(centerOffset: number, viewportHeight: number) {
  return Math.max(0, centerOffset - Math.max(0, Math.floor((viewportHeight - 1) / 2)));
}

function createViewportSizedBottomHunkDiffFile(id: string, path: string) {
  const beforeLines = Array.from(
    { length: 20 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];

  afterLines[1] = "export const line2 = 200;";
  afterLines[13] = "export const line14 = 1400;";
  afterLines[14] = "export const line15 = 1500;";
  afterLines[15] = "export const line16 = 1600;";

  return createTestDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
}

function createWrappedViewportSizedBottomHunkDiffFile(id: string, path: string) {
  const beforeLines = Array.from(
    { length: 20 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];

  afterLines[1] = "export const line2 = 200;";
  afterLines[13] =
    "export const line14 = 'this is a long wrapped replacement for line 14 in the selected hunk';";
  afterLines[14] =
    "export const line15 = 'this is a long wrapped replacement for line 15 in the selected hunk';";

  return createTestDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
}

function createTallDiffFile(id: string, path: string, count: number) {
  const before = lines(
    ...Array.from({ length: count }, (_, index) => `export const line${index + 1} = ${index + 1};`),
  );
  const after = lines(
    ...Array.from(
      { length: count },
      (_, index) => `export const line${index + 1} = ${index + 1001};`,
    ),
  );

  return createTestDiffFile(id, path, before, after);
}

function createCollapsedTopDiffFile(
  id: string,
  path: string,
  totalLines: number,
  changedLine: number,
) {
  const beforeLines = Array.from(
    { length: totalLines },
    (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[changedLine - 1] = `export const line${changedLine} = 9999;`;

  return createTestDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
}

/** Build a file whose first hunk leaves a collapsed gap that can be expanded. */
function createExpandableContextDiffFile(
  id: string,
  path: string,
  sourceFetcher?: DiffFile["sourceFetcher"],
) {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
  const after = before.replace("line 5\n", "line 5 modified\n");

  return {
    after,
    file: buildTestDiffFile({ after, before, context: 3, id, path, sourceFetcher }),
  };
}

function createDiffPaneProps(
  files: DiffFile[],
  theme = resolveTheme("midnight", null),
  overrides: Partial<Parameters<typeof DiffPane>[0]> = {},
): Parameters<typeof DiffPane>[0] {
  return {
    diffContentWidth: 72,
    files,
    headerLabelWidth: 40,
    headerStatsWidth: 16,
    layout: "split" as const,
    scrollRef: createRef<ScrollBoxRenderable>(),
    selectedFileId: files[0]?.id,
    selectedHunkIndex: 0,
    separatorWidth: 68,
    showAgentNotes: false,
    showLineNumbers: true,
    showHunkHeaders: true,
    wrapLines: false,
    wrapToggleScrollTop: null,
    theme,
    width: 76,
    onSelectFile: () => {},
    ...overrides,
  };
}

function settleDiffPane(setup: Awaited<ReturnType<typeof testRender>>) {
  return act(async () => {
    await setup.renderOnce();
    await Bun.sleep(100);
    await setup.renderOnce();
  });
}

async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
  attempts = 8,
) {
  let frame = setup.captureCharFrame();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate(frame)) {
      return frame;
    }

    await act(async () => {
      await Bun.sleep(50);
      await setup.renderOnce();
    });
    frame = setup.captureCharFrame();
  }

  return frame;
}

function createBootstrap(): AppBootstrap {
  return createTestVcsAppBootstrap({
    agentSummary: "Changeset summary",
    changesetId: "changeset:ui",
    files: [
      createTestDiffFile(
        "alpha",
        "alpha.ts",
        "export const alpha = 1;\n",
        "export const alpha = 2;\nexport const add = true;\n",
        true,
      ),
      createTestDiffFile(
        "beta",
        "beta.ts",
        "export const beta = 1;\n",
        "export const betaValue = 1;\n",
      ),
    ],
    initialMode: "split",
    inputMode: "auto",
    summary: "Patch summary",
  });
}

function createWrapBootstrap(): AppBootstrap {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:wrap",
    files: [
      createTestDiffFile(
        "wrap",
        "wrap.ts",
        "export const message = 'short';\n",
        "export const message = 'this is a very long wrapped line for diff rendering coverage';\n",
      ),
    ],
  });
}

function createEmptyDiffFile(type: "change" | "rename-pure" | "new" | "deleted"): DiffFile {
  return {
    id: `empty:${type}`,
    path: `${type}.ts`,
    patch: "",
    language: "typescript",
    stats: {
      additions: 0,
      deletions: 0,
    },
    metadata: {
      hunks: [],
      type,
    } as never,
    agent: null,
  };
}

async function captureFrame(node: ReactNode, width = 120, height = 24) {
  const setup = await testRender(node, { width, height });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

function frameHasHighlightedMarker(
  frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown; bg?: unknown }> }> },
  marker: string,
) {
  return frame.lines.some((line) => {
    const text = line.spans.map((span) => span.text).join("");

    if (!text.includes(marker)) {
      return false;
    }

    return line.spans.some(
      (span) => span.text.includes(marker) && span.text.trim().length < text.trim().length,
    );
  });
}

/** Measure the rendered background contrast between one word-diff span and its surrounding line. */
function renderedWordDiffBackgroundDistance(
  frame: { lines: Array<{ spans: Array<{ text: string; bg?: { buffer?: ArrayLike<number> } }> }> },
  marker: string,
) {
  for (const line of frame.lines) {
    const spanIndex = line.spans.findIndex((span) => span.text.includes(marker));
    if (spanIndex <= 0) {
      continue;
    }

    const wordBg = capturedTestColorToHex(line.spans[spanIndex]?.bg);
    const surroundingBg = capturedTestColorToHex(line.spans[spanIndex - 1]?.bg);
    if (!wordBg || !surroundingBg) {
      continue;
    }

    return hexColorDistance(wordBg, surroundingBg);
  }

  return null;
}

describe("UI components", () => {
  test("SidebarPane renders grouped file rows with indented filenames and right-aligned stats", async () => {
    const theme = resolveTheme("midnight", null);
    const files = [
      createTestDiffFile(
        "app",
        "src/ui/App.tsx",
        "export const app = 1;\n",
        "export const app = 2;\nexport const view = true;\n",
        true,
      ),
      createTestDiffFile(
        "menu",
        "src/ui/MenuDropdown.tsx",
        lines(
          "export const menu = 1;",
          "export const remove1 = true;",
          "export const remove2 = true;",
          "export const remove3 = true;",
        ),
        "export const menu = 1;\n",
      ),
      createTestDiffFile(
        "watch",
        "src/core/watch.ts",
        "export const watch = 1;\n",
        lines(
          "export const watch = 1;",
          "export const add1 = true;",
          "export const add2 = true;",
          "export const add3 = true;",
          "export const add4 = true;",
          "export const add5 = true;",
        ),
      ),
      {
        ...createTestDiffFile(
          "rename",
          "src/ui/Renamed.tsx",
          "export const renamed = true;\n",
          "export const renamed = true;\n",
        ),
        previousPath: "src/ui/Legacy.tsx",
        stats: { additions: 0, deletions: 0 },
      },
    ];
    const frame = await captureFrame(
      <SidebarPane
        entries={buildSidebarEntries(files)}
        scrollRef={createRef()}
        selectedFileId="app"
        textWidth={28}
        theme={theme}
        width={32}
        onSelectFile={() => {}}
      />,
      36,
      10,
    );

    expect(frame).toContain("src/ui/");
    expect(frame).toContain("src/core/");
    expect(frame).toContain(" App.tsx");
    expect(frame).toContain(" MenuDropdown.tsx");
    expect(frame).toContain(" watch.ts");
    expect(frame).toContain("*1 +2 -1");
    expect(frame).toContain("+5");
    expect(frame).toContain("-3");
    expect(frame).not.toContain("+0");
    expect(frame).not.toContain("-0");
    expect(frame).not.toContain("M +2 -1 AI");
  });

  test("DiffPane renders all diff sections in file order", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={72}
        files={bootstrap.changeset.files}
        headerLabelWidth={40}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={68}
        showAgentNotes={false}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={76}
        onSelectFile={() => {}}
      />,
      80,
      18,
    );

    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).not.toContain("[AI]");
    expect(frame.indexOf("alpha.ts")).toBeLessThan(frame.indexOf("beta.ts"));
  });

  test("DiffFileHeaderRow leaves one column after line counts", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffFileHeaderRow
        file={createTestDiffFile(
          "stats-align",
          "stats-align.ts",
          lines("export const value = 1;"),
          lines("export const value = 2;", "export const next = 3;"),
        )}
        headerLabelWidth={20}
        headerStatsWidth={8}
        theme={theme}
      />,
      40,
      2,
    );
    const firstLine = frame.split("\n")[0] ?? "";
    const statsIndex = firstLine.indexOf("+2 -1");

    expect(statsIndex).toBeGreaterThanOrEqual(0);
    expect(firstLine[statsIndex + "+2 -1".length]).toBe(" ");
    expect(firstLine[statsIndex + "+2 -1".length + 1]).toBe(" ");
  });

  test("DiffRowView renders a clickable add-note affordance for a hovered diff row", async () => {
    const theme = resolveTheme("midnight", null);
    const startUserNote = mock(() => undefined);
    const setup = await testRender(
      <DiffRowView
        row={{
          type: "stack-line",
          key: "alpha:line:1",
          fileId: "alpha",
          hunkIndex: 0,
          cell: {
            kind: "addition",
            sign: "+",
            newLineNumber: 2,
            spans: [{ text: "export const alpha = 2;" }],
          },
        }}
        width={72}
        lineNumberDigits={1}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        codeHorizontalOffset={0}
        theme={theme}
        selected={false}
        showAddNoteBadge={true}
        onStartUserNoteAtHunk={startUserNote}
      />,
      { width: 80, height: 3 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("[+]");
      const addNoteY = frame.split("\n").findIndex((line) => line.includes("[+]"));
      const addNoteX = frame.split("\n")[addNoteY]?.indexOf("[+]") ?? -1;
      expect(addNoteY).toBeGreaterThanOrEqual(0);
      expect(addNoteX).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup.mockMouse.click(4, addNoteY);
      });
      expect(startUserNote).not.toHaveBeenCalled();

      await act(async () => {
        await setup.mockMouse.click(addNoteX + 1, addNoteY);
      });
      expect(startUserNote).toHaveBeenCalledWith(0, { side: "new", line: 2 });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffRowView keeps wrapped text stable when showing the add-note affordance", async () => {
    const theme = resolveTheme("midnight", null);
    const row = {
      type: "stack-line" as const,
      key: "alpha:line:hover-wrap",
      fileId: "alpha",
      hunkIndex: 0,
      cell: {
        kind: "addition" as const,
        sign: "+" as const,
        newLineNumber: 2,
        spans: [{ text: "abcdefghij klmnopqrst uvwxyz" }],
      },
    };
    const renderRow = (showAddNoteBadge: boolean) =>
      captureFrame(
        <DiffRowView
          row={row}
          width={24}
          lineNumberDigits={1}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={true}
          codeHorizontalOffset={0}
          theme={theme}
          selected={false}
          showAddNoteBadge={showAddNoteBadge}
          onStartUserNoteAtHunk={() => {}}
        />,
        32,
        5,
      );
    const normalize = (frame: string) =>
      frame
        .replace("[+]", "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);

    const hiddenFrame = await renderRow(false);
    const shownFrame = await renderRow(true);

    expect(normalize(shownFrame)).toEqual(normalize(hiddenFrame));
  });

  test("DiffRowView fills the reserved wrapped add-note column with row background", async () => {
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <DiffRowView
        row={{
          type: "stack-line",
          key: "alpha:line:hover-wrap-bg",
          fileId: "alpha",
          hunkIndex: 0,
          cell: {
            kind: "addition",
            sign: "+",
            newLineNumber: 2,
            spans: [{ text: "abcdefghij klmnopqrst uvwxyz" }],
          },
        }}
        width={24}
        lineNumberDigits={1}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={true}
        codeHorizontalOffset={0}
        theme={theme}
        selected={false}
        onStartUserNoteAtHunk={() => {}}
      />,
      { width: 32, height: 5 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const line = setup
        .captureSpans()
        .lines.find((nextLine) => nextLine.spans.some((span) => span.text.includes("abcdefghij")));
      const hasAddedBgSpacer = line?.spans.some(
        (span) =>
          span.text === " ".repeat(3) &&
          capturedTestColorToHex(span.bg)?.toLowerCase() === theme.addedBg.toLowerCase(),
      );

      expect(hasAddedBgSpacer).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffRowView keeps metadata row background within the measured row width", async () => {
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <DiffRowView
        row={{
          type: "hunk-header",
          key: "alpha:hunk:0",
          fileId: "alpha",
          hunkIndex: 0,
          text: "@@ -1 +1 @@",
        }}
        width={24}
        lineNumberDigits={1}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={true}
        codeHorizontalOffset={0}
        theme={theme}
        selected={false}
      />,
      { width: 32, height: 2 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const panelAltWidth = setup.captureSpans().lines[0]?.spans.reduce((total, span) => {
        return capturedTestColorToHex(span.bg)?.toLowerCase() === theme.panelAlt.toLowerCase()
          ? total + span.text.length
          : total;
      }, 0);

      expect(panelAltWidth).toBe(24);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffRowView preserves zero-width combining spans in nowrap and wrapped rows", async () => {
    const theme = resolveTheme("midnight", null);
    const row = {
      type: "stack-line" as const,
      key: "alpha:line:combining",
      fileId: "alpha",
      hunkIndex: 0,
      cell: {
        kind: "addition" as const,
        sign: "+" as const,
        newLineNumber: 2,
        spans: [{ text: "e" }, { text: "\u0301" }, { text: "x" }],
      },
    };

    for (const wrapLines of [false, true]) {
      const setup = await testRender(
        <DiffRowView
          row={row}
          width={40}
          lineNumberDigits={1}
          showLineNumbers={true}
          showHunkHeaders={true}
          wrapLines={wrapLines}
          codeHorizontalOffset={0}
          theme={theme}
          selected={false}
        />,
        { width: 48, height: 3 },
      );

      try {
        await act(async () => {
          await setup.renderOnce();
        });
        expect(setup.captureCharFrame()).toContain("e\u0301x");
      } finally {
        await act(async () => {
          setup.renderer.destroy();
        });
      }
    }
  });

  test("DiffPane only shows the add-note affordance after pointer movement", async () => {
    const files = createWindowingFiles(6);
    const theme = resolveTheme("midnight", null);
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps(files, theme, {
      diffContentWidth: 88,
      scrollRef,
      onStartUserNoteAtHunk: () => {},
      separatorWidth: 84,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 12,
    });

    try {
      await settleDiffPane(setup);

      await act(async () => {
        await setup.mockMouse.moveTo(32, 4);
        await setup.renderOnce();
      });
      let frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("[+]"), 12);
      expect(frame).toContain("[+]");

      await act(async () => {
        await setup.mockMouse.scroll(32, 4, "down");
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      frame = await waitForFrame(setup, (nextFrame) => !nextFrame.includes("[+]"), 12);
      expect(frame).not.toContain("[+]");

      await act(async () => {
        await Bun.sleep(250);
        await setup.renderOnce();
      });
      frame = setup.captureCharFrame();
      expect(frame).not.toContain("[+]");

      await act(async () => {
        await setup.mockMouse.moveTo(34, 4);
        await setup.renderOnce();
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("[+]"), 12);
      expect(frame).toContain("[+]");

      await act(async () => {
        scrollRef.current?.scrollTo({ x: 0, y: 2 });
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      frame = await waitForFrame(setup, (nextFrame) => !nextFrame.includes("[+]"), 12);
      expect(frame).not.toContain("[+]");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane scrolls a later selected file into view in the windowed path", async () => {
    const files = createWindowingFiles(6);
    const theme = resolveTheme("midnight", null);
    const props = createDiffPaneProps(files, theme, {
      diffContentWidth: 88,
      selectedFileId: files[5]?.id,
      separatorWidth: 84,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 12,
    });

    try {
      await settleDiffPane(setup);
      const frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("window-6.ts") && nextFrame.includes("file6Extra = true"),
        20,
      );

      expect(frame).toContain("window-6.ts");
      expect(frame).toContain("export const file6Extra = true;");
      expect(frame).not.toContain("window-1.ts");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane scrolls to the selected later hunk when hunk headers are hidden", async () => {
    const theme = resolveTheme("midnight", null);
    const files = [
      createTestDiffFile(
        "intro",
        "intro.ts",
        lines("export const intro = 1;"),
        lines("export const intro = 2;", "export const introExtra = true;"),
      ),
      createMultiHunkDiffFile("target", "target.ts"),
    ];
    const props = createDiffPaneProps(files, theme, {
      diffContentWidth: 96,
      headerLabelWidth: 48,
      selectedFileId: "target",
      selectedHunkIndex: 1,
      separatorWidth: 92,
      showHunkHeaders: false,
      width: 100,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 104,
      height: 12,
    });

    try {
      await settleDiffPane(setup);
      const frame = setup.captureCharFrame();

      expect(frame).toContain("11 - export const line11 = 11;");
      expect(frame).toContain("11 + export const line11 = 1100;");
      expect(frame).not.toContain("2 - export const line2 = 2;");
      expect(frame).not.toContain("2 + export const line2 = 200;");
      expect(frame).not.toContain("intro.ts");
      expect(frame).not.toContain("@@ -1,3 +1,3 @@");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane viewport-follow selection does not move the scroll position", async () => {
    const theme = resolveTheme("midnight", null);
    const files = [
      createTestDiffFile(
        "first",
        "first.ts",
        lines("export const alpha = 1;"),
        lines("export const alpha = 2;"),
      ),
      createWideTwoHunkDiffFile("second", "second.ts", 100),
    ];
    const scrollRef = createRef<ScrollBoxRenderable>();
    let latestSelection = { fileId: files[0]!.id, hunkIndex: 0 };

    function ViewportSelectionHarness() {
      const [selection, setSelection] = useState(latestSelection);

      return (
        <DiffPane
          {...createDiffPaneProps(files, theme, {
            diffContentWidth: 96,
            headerLabelWidth: 48,
            scrollRef,
            selectedFileId: selection.fileId,
            selectedHunkIndex: selection.hunkIndex,
            selectedHunkRevealRequestId: 0,
            separatorWidth: 92,
            width: 100,
          })}
          onViewportCenteredHunkChange={(fileId, hunkIndex) => {
            latestSelection = { fileId, hunkIndex };
            setSelection(latestSelection);
          }}
        />
      );
    }

    const setup = await testRender(<ViewportSelectionHarness />, {
      width: 104,
      height: 12,
    });

    const sectionGeometry = files.map((file) =>
      measureDiffSectionGeometry(file, "split", true, theme, [], 96, true, false),
    );
    const fileSectionLayouts = buildFileSectionLayouts(
      files,
      sectionGeometry.map((geometry) => geometry.bodyHeight),
      buildInStreamFileHeaderHeights(files),
    );

    try {
      await settleDiffPane(setup);

      const viewportHeight = scrollRef.current?.viewport.height ?? 0;
      expect(viewportHeight).toBeGreaterThan(0);

      const secondFileSecondHunkTop =
        fileSectionLayouts[1]!.bodyTop + sectionGeometry[1]!.hunkBounds.get(1)!.top;
      const targetScrollTop = scrollTopForCenter(secondFileSecondHunkTop, viewportHeight);

      await act(async () => {
        scrollRef.current?.scrollTo(targetScrollTop);
      });
      await settleDiffPane(setup);

      expect(latestSelection).toEqual({ fileId: "second", hunkIndex: 1 });
      expect(scrollRef.current?.scrollTop ?? 0).toBe(targetScrollTop);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps the sticky-header lane stable through the divider and next-header handoff", async () => {
    const theme = resolveTheme("midnight", null);
    const firstFile = createTallDiffFile("first", "first.ts", 18);
    const secondFile = createTallDiffFile("second", "second.ts", 18);
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps([firstFile, secondFile], theme, {
      diffContentWidth: 88,
      headerLabelWidth: 48,
      headerStatsWidth: 16,
      scrollRef,
      separatorWidth: 84,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 10,
    });

    const firstBodyHeight = measureDiffSectionGeometry(
      firstFile,
      "split",
      true,
      theme,
      [],
      88,
      true,
      false,
    ).bodyHeight;
    const secondHeaderTop = firstBodyHeight + 1;
    const separatorTop = firstBodyHeight;
    const settleStickyScroll = async () => {
      await act(async () => {
        for (let iteration = 0; iteration < 6; iteration += 1) {
          await Bun.sleep(60);
          await setup.renderOnce();
        }
      });
    };

    try {
      await settleDiffPane(setup);

      let frame = setup.captureCharFrame();
      expect((frame.match(/first\.ts/g) ?? []).length).toBe(1);

      await act(async () => {
        scrollRef.current?.scrollTo(3);
      });
      await settleStickyScroll();

      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("first.ts"));
      expect(frame).toContain("first.ts");
      const stickyViewportHeight = scrollRef.current?.viewport.height ?? 0;
      expect(stickyViewportHeight).toBeGreaterThan(0);

      await act(async () => {
        scrollRef.current?.scrollTo(separatorTop);
      });
      await settleStickyScroll();

      frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("first.ts") && nextFrame.includes("────"),
      );
      expect(frame).toContain("first.ts");
      expect(frame).toContain("────");
      expect(scrollRef.current?.viewport.height ?? 0).toBe(stickyViewportHeight);

      await act(async () => {
        scrollRef.current?.scrollTo(secondHeaderTop);
      });
      await settleStickyScroll();

      frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("first.ts") && nextFrame.includes("second.ts"),
      );
      expect(frame).toContain("first.ts");
      expect(frame).toContain("second.ts");
      expect(scrollRef.current?.viewport.height ?? 0).toBe(stickyViewportHeight);

      await act(async () => {
        scrollRef.current?.scrollTo(secondHeaderTop + 1);
      });
      await settleStickyScroll();

      frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("second.ts") && !nextFrame.includes("first.ts"),
      );
      expect(frame).not.toContain("first.ts");
      expect(frame).toContain("second.ts");
      expect(frame).toContain("@@ -1,18 +1,18 @@");
      expect(scrollRef.current?.viewport.height ?? 0).toBe(stickyViewportHeight);

      await act(async () => {
        scrollRef.current?.scrollTo(secondHeaderTop + 2);
      });
      await settleStickyScroll();

      frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("second.ts") && !nextFrame.includes("@@ -1,18 +1,18 @@"),
      );
      expect(frame).toContain("second.ts");
      expect(frame).not.toContain("@@ -1,18 +1,18 @@");
      expect(scrollRef.current?.viewport.height ?? 0).toBe(stickyViewportHeight);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane positions later files after expanded context rows", async () => {
    const theme = resolveTheme("midnight", null);
    const beforeLines = Array.from({ length: 30 }, (_, index) => `first line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[4] = "first line 5 changed";
    const after = lines(...afterLines);
    const firstFile = buildTestDiffFile({
      after,
      before: lines(...beforeLines),
      context: 0,
      id: "first-expanded",
      path: "first-expanded.ts",
    });
    const secondFile = createTestDiffFile(
      "second-after-expanded",
      "second-after-expanded.ts",
      "export const second = 1;\n",
      "export const second = 2;\n",
    );
    const files = [firstFile, secondFile];
    const expandedKeys = new Set(["trailing:0"]);
    const sourceStatus = { kind: "loaded", text: after } as const;
    const firstGeometry = measureDiffSectionGeometry(
      firstFile,
      "split",
      true,
      theme,
      [],
      88,
      true,
      false,
      expandedKeys,
      sourceStatus,
    );
    const secondGeometry = measureDiffSectionGeometry(secondFile, "split", true, theme, [], 88);
    const fileSectionLayouts = buildFileSectionLayouts(
      files,
      [firstGeometry.bodyHeight, secondGeometry.bodyHeight],
      buildInStreamFileHeaderHeights(files),
    );
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps(files, theme, {
      diffContentWidth: 88,
      expandedGapsByFileId: { [firstFile.id]: expandedKeys },
      headerLabelWidth: 48,
      headerStatsWidth: 16,
      scrollRef,
      separatorWidth: 84,
      sourceStatusByFileId: { [firstFile.id]: sourceStatus },
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 10,
    });

    try {
      await settleDiffPane(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("Hide 25 unchanged lines");
      expect(frame).toContain("first line 6");
      expect(frame).not.toContain("second-after-expanded.ts");

      await act(async () => {
        scrollRef.current?.scrollTo(fileSectionLayouts[1]!.sectionTop);
      });
      await settleDiffPane(setup);

      frame = await waitForFrame(setup, (nextFrame) =>
        nextFrame.includes("second-after-expanded.ts"),
      );
      expect(frame).toContain("second-after-expanded.ts");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane advances the review stream under the always-pinned file header above a collapsed gap", async () => {
    const theme = resolveTheme("midnight", null);
    const firstFile = createCollapsedTopDiffFile("late", "late.ts", 400, 366);
    const secondFile = createTallDiffFile("second", "second.ts", 4);
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps([firstFile, secondFile], theme, {
      diffContentWidth: 88,
      headerLabelWidth: 48,
      headerStatsWidth: 16,
      scrollRef,
      separatorWidth: 84,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 9,
    });

    try {
      await settleDiffPane(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("late.ts");
      expect(frame).toContain("··· 362 unchanged lines ···");
      expect(frame).not.toContain("366 - export const line366 = 366;");

      await act(async () => {
        scrollRef.current?.scrollTo(1);
      });
      await settleDiffPane(setup);

      frame = await waitForFrame(setup, (nextFrame) =>
        nextFrame.includes("366 - export const line366 = 366;"),
      );
      expect(frame).toContain("366 - export const line366 = 366;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane returns cleanly to the collapsed-gap view after scrolling back up under the pinned file header", async () => {
    const theme = resolveTheme("midnight", null);
    const firstFile = createCollapsedTopDiffFile("late", "late.ts", 400, 366);
    const secondFile = createTallDiffFile("second", "second.ts", 4);
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps([firstFile, secondFile], theme, {
      diffContentWidth: 88,
      headerLabelWidth: 48,
      headerStatsWidth: 16,
      scrollRef,
      separatorWidth: 84,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 9,
    });

    try {
      await settleDiffPane(setup);

      await act(async () => {
        scrollRef.current?.scrollTo(1);
      });
      await settleDiffPane(setup);

      let frame = await waitForFrame(setup, (nextFrame) =>
        nextFrame.includes("366 - export const line366 = 366;"),
      );
      expect((frame.match(/late\.ts/g) ?? []).length).toBe(1);

      await act(async () => {
        scrollRef.current?.scrollTo(0);
      });
      await settleDiffPane(setup);

      frame = await waitForFrame(
        setup,
        (nextFrame) =>
          nextFrame.includes("··· 362 unchanged lines ···") &&
          (nextFrame.match(/late\.ts/g) ?? []).length === 1,
      );
      expect(frame).toContain("··· 362 unchanged lines ···");
      expect(frame).not.toContain("366 - export const line366 = 366;");
      expect((frame.match(/late\.ts/g) ?? []).length).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps bottom scroll stable when offscreen agent notes are windowed out", async () => {
    const theme = resolveTheme("midnight", null);
    const firstFile = createTallDiffFile("first", "first.ts", 18);
    firstFile.agent = {
      path: firstFile.path,
      summary: "first.ts note",
      annotations: [
        {
          newRange: [2, 2],
          summary: "Offscreen note should still reserve geometry at EOF.",
          rationale:
            "If measurement drops this note after first.ts leaves the viewport, max scroll shrinks.",
        },
      ],
    };
    const files = [firstFile, createTallDiffFile("last", "last.ts", 24)];
    const scrollRef = createRef<ScrollBoxRenderable>();
    const props = createDiffPaneProps(files, theme, {
      diffContentWidth: 88,
      headerLabelWidth: 48,
      headerStatsWidth: 16,
      scrollRef,
      selectedFileId: undefined,
      separatorWidth: 84,
      showAgentNotes: true,
      width: 92,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 96,
      height: 10,
    });

    try {
      await settleDiffPane(setup);

      let bottomScrollTop = 0;
      await act(async () => {
        scrollRef.current?.scrollTo(1_000_000);
        bottomScrollTop = scrollRef.current?.scrollTop ?? 0;
      });
      expect(bottomScrollTop).toBeGreaterThan(0);

      await settleDiffPane(setup);
      expect(scrollRef.current?.scrollTop ?? 0).toBe(bottomScrollTop);

      await act(async () => {
        scrollRef.current?.scrollTo(bottomScrollTop + 1);
      });
      await settleDiffPane(setup);

      expect(scrollRef.current?.scrollTop ?? 0).toBe(bottomScrollTop);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane lets manual scrolling move away from a bottom-clamped file-top alignment", async () => {
    const theme = resolveTheme("midnight", null);
    const files = [
      createTallDiffFile("first", "first.ts", 30),
      createTestDiffFile(
        "second",
        "second.ts",
        lines(
          "export const shortLine1 = 1;",
          "export const shortLine2 = 2;",
          "export const shortLine3 = 3;",
        ),
        lines(
          "export const shortLine1 = 10;",
          "export const shortLine2 = 20;",
          "export const shortLine3 = 30;",
        ),
      ),
    ];
    const scrollRef = createRef<ScrollBoxRenderable>();

    function BottomAlignedFileHarness() {
      const [selectedFileTopAlignRequestId, setSelectedFileTopAlignRequestId] = useState(0);

      useEffect(() => {
        setSelectedFileTopAlignRequestId(1);
      }, []);

      return (
        <DiffPane
          {...createDiffPaneProps(files, theme, {
            diffContentWidth: 88,
            headerLabelWidth: 48,
            headerStatsWidth: 16,
            scrollRef,
            selectedFileId: "second",
            selectedHunkIndex: 0,
            selectedFileTopAlignRequestId,
            separatorWidth: 84,
            width: 92,
          })}
        />
      );
    }

    const setup = await testRender(<BottomAlignedFileHarness />, {
      width: 96,
      height: 10,
    });

    try {
      await settleDiffPane(setup);

      const bottomScrollTop = scrollRef.current?.scrollTop ?? 0;
      expect(bottomScrollTop).toBeGreaterThan(0);

      await act(async () => {
        scrollRef.current?.scrollTo(bottomScrollTop - 1);
      });
      await settleDiffPane(setup);

      expect(scrollRef.current?.scrollTop ?? 0).toBe(bottomScrollTop - 1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps a viewport-sized selected hunk fully visible when it fits", async () => {
    const theme = resolveTheme("midnight", null);
    const props = createDiffPaneProps(
      [createViewportSizedBottomHunkDiffFile("target", "target.ts")],
      theme,
      {
        diffContentWidth: 96,
        headerLabelWidth: 48,
        selectedFileId: "target",
        selectedHunkIndex: 1,
        separatorWidth: 92,
        showHunkHeaders: false,
        width: 100,
      },
    );
    const setup = await testRender(<DiffPane {...props} />, {
      width: 104,
      height: 12,
    });

    try {
      await settleDiffPane(setup);
      const frame = setup.captureCharFrame();

      expect(frame).toContain("export const line11 = 11;");
      expect(frame).toContain("14 - export const line14 = 14;");
      expect(frame).toContain("14 + export const line14 = 1400;");
      expect(frame).toContain("16 - export const line16 = 16;");
      expect(frame).toContain("16 + export const line16 = 1600;");
      expect(frame).not.toContain("2 - export const line2 = 2;");
      expect(frame).not.toContain("2 + export const line2 = 200;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps a selected wrapped hunk fully visible when it fits", async () => {
    const theme = resolveTheme("midnight", null);
    const props = createDiffPaneProps(
      [createWrappedViewportSizedBottomHunkDiffFile("target", "target.ts")],
      theme,
      {
        diffContentWidth: 76,
        headerLabelWidth: 40,
        selectedFileId: "target",
        selectedHunkIndex: 1,
        separatorWidth: 72,
        showHunkHeaders: false,
        width: 80,
        wrapLines: true,
      },
    );
    const setup = await testRender(<DiffPane {...props} />, {
      width: 84,
      height: 16,
    });

    try {
      await settleDiffPane(setup);
      const frame = setup.captureCharFrame();

      expect(frame).toContain("11   export const line11 = 11;");
      expect(frame).toContain("14 + export const line14 = 'this is a");
      expect(frame).toContain("15 + export const line15 = 'this is a");
      expect(frame).toContain("18   export const line18 = 18;");
      expect(frame).not.toContain("2 - export const line2 = 2;");
      expect(frame).not.toContain("2 + export const line2 = 200;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps a distant selected hunk visible when row windowing narrows one file body", async () => {
    const theme = resolveTheme("midnight", null);
    const props = createDiffPaneProps([createWideTwoHunkDiffFile("target", "target.ts")], theme, {
      diffContentWidth: 96,
      headerLabelWidth: 48,
      selectedFileId: "target",
      selectedHunkIndex: 1,
      separatorWidth: 92,
      width: 100,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 104,
      height: 12,
    });

    try {
      await settleDiffPane(setup);
      const frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("line60 = 5901"));

      expect(frame).toContain("line60 = 5901");
      expect(frame).not.toContain("line1 = 1001");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane keeps a selected hunk with inline notes fully visible when it fits", async () => {
    const theme = resolveTheme("midnight", null);
    const file = createViewportSizedBottomHunkDiffFile("target", "target.ts");
    file.agent = {
      path: file.path,
      summary: "target note",
      annotations: [
        {
          newRange: [14, 16],
          summary: "Keep the selected hunk visible with its note.",
        },
      ],
    };
    const props = createDiffPaneProps([file], theme, {
      diffContentWidth: 96,
      headerLabelWidth: 48,
      selectedFileId: "target",
      selectedHunkIndex: 1,
      separatorWidth: 92,
      showAgentNotes: true,
      showHunkHeaders: false,
      width: 100,
    });
    const setup = await testRender(<DiffPane {...props} />, {
      width: 104,
      height: 20,
    });

    try {
      await settleDiffPane(setup);
      const frame = setup.captureCharFrame();

      expect(frame).toContain("Keep the selected hunk visible with its");
      expect(frame).toContain("note.");
      expect(frame).toContain("11   export const line11 = 11;");
      expect(frame).toContain("16 + export const line16 = 1600;");
      expect(frame).toContain("export const line19 = 19;");
      expect(frame).not.toContain("2 - export const line2 = 2;");
      expect(frame).not.toContain("2 + export const line2 = 200;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("DiffPane scrollToNote positions the inline note near the viewport top instead of the hunk top", async () => {
    const theme = resolveTheme("midnight", null);

    // Build a file with two distant hunks so the second hunk is far below the first when scrolled
    // to the hunk top. The annotation anchors on the second hunk.
    const beforeLines = Array.from(
      { length: 80 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    );
    const afterLines = [...beforeLines];
    // Hunk 0: change at line 1
    afterLines[0] = "export const line1 = 100;";
    // Hunk 1: changes at lines 60-65 to make a multi-line hunk
    afterLines[59] = "export const line60 = 6000;";
    afterLines[60] = "export const line61 = 6100;";
    afterLines[61] = "export const line62 = 6200;";
    afterLines[62] = "export const line63 = 6300;";
    afterLines[63] = "export const line64 = 6400;";
    afterLines[64] = "export const line65 = 6500;";

    const file = createTestDiffFile(
      "deep-note",
      "deep-note.ts",
      lines(...beforeLines),
      lines(...afterLines),
    );
    file.agent = {
      path: file.path,
      summary: "file note",
      annotations: [
        {
          newRange: [63, 63],
          summary: "Note anchored on second hunk.",
        },
      ],
    };

    // Without scrollToNote: hunk top (context before line 60) is near viewport top,
    // but the note card (anchored at line 63) may be below the visible area.
    const propsWithoutFlag = createDiffPaneProps([file], theme, {
      diffContentWidth: 96,
      headerLabelWidth: 48,
      selectedFileId: "deep-note",
      selectedHunkIndex: 1,
      separatorWidth: 92,
      showAgentNotes: true,
      showHunkHeaders: true,
      width: 100,
    });
    const setupWithout = await testRender(<DiffPane {...propsWithoutFlag} />, {
      width: 104,
      height: 12,
    });

    try {
      await settleDiffPane(setupWithout);
      const frameWithout = setupWithout.captureCharFrame();

      // Hunk context (lines near 57-59) should be visible at the top.
      expect(frameWithout).toContain("line57");
      // Note card should NOT be visible — it's below the 12-row viewport.
      expect(frameWithout).not.toContain("Note anchored on second hunk.");
    } finally {
      await act(async () => {
        setupWithout.renderer.destroy();
      });
    }

    // With scrollToNote: note card should be near the viewport top.
    const propsWithFlag = createDiffPaneProps([file], theme, {
      diffContentWidth: 96,
      headerLabelWidth: 48,
      selectedFileId: "deep-note",
      selectedHunkIndex: 1,
      scrollToNote: true,
      separatorWidth: 92,
      showAgentNotes: true,
      showHunkHeaders: true,
      width: 100,
    });
    const setupWith = await testRender(<DiffPane {...propsWithFlag} />, {
      width: 104,
      height: 12,
    });

    try {
      await settleDiffPane(setupWith);
      const frameWith = setupWith.captureCharFrame();

      // Note should be visible.
      expect(frameWith).toContain("Note anchored on second hunk.");
    } finally {
      await act(async () => {
        setupWith.renderer.destroy();
      });
    }
  });

  test("AgentCard removes top and bottom padding while keeping the footer inside the frame", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentCard
        locationLabel="alpha.ts +2"
        rationale="Why alpha.ts changed"
        summary="Annotation for alpha.ts"
        theme={theme}
        width={34}
        onClose={() => {}}
      />,
      40,
      12,
    );

    const lines = frame
      .split("\n")
      .slice(0, 8)
      .map((line) => line.trimEnd());
    expect(lines[0]).toBe("┌────────────────────────────────┐");
    expect(lines[1]).toContain("AI note");
    expect(lines[2]).toContain("Annotation for alpha.ts");
    expect(lines[4]).toContain("Why alpha.ts changed");
    expect(lines[6]).toContain("alpha.ts +2");
    expect(lines[7]).toBe("└────────────────────────────────┘");
  });

  test("AgentInlineNote renders a connected bordered panel without a blank connector row", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [2, 4],
          summary: "Summary line",
          rationale: "Rationale line.",
        }}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
        onClose={() => {}}
      />,
      100,
      5,
    );

    const lines = frame.split("\n");
    expect(lines[0]?.trimStart().startsWith("╭")).toBe(true);
    expect(lines[0]).toContain("Agent note - R2–R4");
    expect(lines[0]).toContain("[x]");
    expect(lines[1]).toContain("│                                              │");
    expect(lines[2]).toContain("Summary line");
    expect(lines[3]).toContain("Rationale line.");
    expect(lines[4]?.trimStart().startsWith("╰")).toBe(true);
  });

  test("AgentInlineNote renders draft notes as an editable composer", async () => {
    const theme = resolveTheme("midnight", null);
    const file = createTestDiffFile(
      "draft",
      "src/core/cli.ts",
      "export const value = 1;\n",
      "export const value = 2;\n",
    );
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [611, 611],
          source: "user-draft",
          summary: "Here's my comment. I think we should think",
        }}
        draft={{
          body: "Here's my comment. I think we should think",
          focused: true,
          onCancel: () => {},
          onInput: () => {},
          onSave: () => {},
        }}
        file={file}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
      />,
      100,
      12,
    );

    const lines = frame.split("\n");
    expect(lines[0]).toContain("╭─ Draft note - src/core/cli.ts R611 ");
    expect(lines[1]).toContain("│                                              │");
    expect(lines[2]).toContain("│ Here's my comment. I think we should think");
    expect(lines[3]).toContain("│                                              │");
    const saveLine = lines.find(
      (line) => line.includes("Save (^S)") && line.includes("Cancel (Esc)"),
    );
    expect(saveLine).toBeDefined();
    expect(saveLine!.indexOf("Save")).toBeGreaterThan(lines[2]!.indexOf("Here's"));
    expect(frame).toContain("┬───────────┬──────────────┤");
    expect(frame).toContain("╰───────────┴──────────────╯");
  });

  test("AgentInlineNote grows draft composer for soft-wrapped text", async () => {
    const theme = resolveTheme("midnight", null);
    const file = createTestDiffFile(
      "draft-wrap",
      "src/core/cli.ts",
      "export const value = 1;\n",
      "export const value = 2;\n",
    );
    const body =
      "This draft note is long enough to soft wrap inside the composer without manually inserted newlines.";
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{ newRange: [611, 611], source: "user-draft", summary: body }}
        draft={{
          body,
          focused: true,
          onCancel: () => {},
          onInput: () => {},
          onSave: () => {},
        }}
        file={file}
        anchorSide="new"
        layout="stack"
        theme={theme}
        width={48}
      />,
      52,
      12,
    );

    const lines = frame.split("\n");
    const saveLineIndex = lines.findIndex(
      (line) => line.includes("Save (^S)") && line.includes("Cancel (Esc)"),
    );
    expect(lines.some((line) => line.includes("soft"))).toBe(true);
    expect(lines.some((line) => line.includes("wrap inside"))).toBe(true);
    expect(saveLineIndex).toBeGreaterThan(5);
  });

  test("AgentInlineNote shows author name in title when author is set", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [2, 4],
          summary: "Summary line",
          author: "sonnet",
        }}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
        onClose={() => {}}
      />,
      100,
      5,
    );

    const lines = frame.split("\n");
    expect(lines[0]).toContain("sonnet");
    expect(lines[0]).not.toContain("AI note");
  });

  test("AgentInlineNote falls back to 'Agent note' when author is absent", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [2, 4],
          summary: "Summary line",
        }}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
        onClose={() => {}}
      />,
      100,
      5,
    );

    const lines = frame.split("\n");
    expect(lines[0]).toContain("Agent note");
  });

  test("AgentInlineNote includes index when multiple notes share a hunk", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [2, 4],
          summary: "Summary line",
          author: "sonnet",
        }}
        anchorSide="new"
        layout="split"
        noteCount={2}
        noteIndex={0}
        theme={theme}
        width={96}
        onClose={() => {}}
      />,
      100,
      5,
    );

    const lines = frame.split("\n");
    expect(lines[0]).toContain("sonnet");
    expect(lines[0]).toContain("1/2");
  });

  test("AgentInlineNote preserves special characters in author", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentInlineNote
        annotation={{
          newRange: [2, 4],
          summary: "Summary line",
          author: "prism (arbiter)",
        }}
        anchorSide="new"
        layout="split"
        theme={theme}
        width={96}
        onClose={() => {}}
      />,
      100,
      5,
    );

    const lines = frame.split("\n");
    expect(lines[0]).toContain("prism (arbiter)");
  });

  test("AgentCard shows author in title when set", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentCard
        locationLabel="alpha.ts +2"
        rationale="Why alpha.ts changed"
        summary="Annotation for alpha.ts"
        author="sonnet"
        theme={theme}
        width={34}
        onClose={() => {}}
      />,
      40,
      12,
    );

    const lines = frame
      .split("\n")
      .slice(0, 8)
      .map((line) => line.trimEnd());
    expect(lines[1]).toContain("sonnet");
    expect(lines[1]).not.toContain("AI note");
  });

  test("AgentCard falls back to 'AI note' when author absent", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentCard
        locationLabel="alpha.ts +2"
        rationale="Why alpha.ts changed"
        summary="Annotation for alpha.ts"
        theme={theme}
        width={34}
        onClose={() => {}}
      />,
      40,
      12,
    );

    const lines = frame
      .split("\n")
      .slice(0, 8)
      .map((line) => line.trimEnd());
    expect(lines[1]).toContain("AI note");
  });

  test("DiffPane renders all visible hunk notes across the review stream", async () => {
    const bootstrap = createBootstrap();
    bootstrap.changeset.files[1]!.agent = {
      path: "beta.ts",
      summary: "beta.ts note",
      annotations: [
        {
          newRange: [1, 1],
          summary: "Annotation for beta.ts",
          rationale: "Why beta.ts changed",
          tags: ["review"],
          confidence: "high",
        },
      ],
    };

    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={88}
        files={bootstrap.changeset.files}
        headerLabelWidth={48}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={84}
        showAgentNotes={true}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={92}
        onSelectFile={() => {}}
      />,
      96,
      28,
    );

    expect(frame).toContain("Agent note - alpha.ts R2");
    expect(frame).toContain("Annotation for alpha.ts");
    expect(frame).toContain("Why alpha.ts changed");
    expect(frame.indexOf("Agent note - alpha.ts R2")).toBeLessThan(
      frame.indexOf("2 + export const add = true;"),
    );
    expect(frame).toContain("Agent note - beta.ts R1");
    expect(frame).toContain("Annotation for beta.ts");
    expect(frame).toContain("Why beta.ts changed");
    expect(frame).not.toContain("alpha.ts note");
    expect(frame).not.toContain("review");
    expect(frame).not.toContain("confidence");
  });

  test("DiffPane split inline notes hand off directly to the anchored row without shifting it", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={88}
        files={bootstrap.changeset.files}
        headerLabelWidth={48}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={84}
        showAgentNotes={true}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={92}
        onSelectFile={() => {}}
      />,
      96,
      16,
    );

    const lines = frame.split("\n");
    const noteBottomIndex = lines.findIndex((line) => line.includes("╰") && line.includes("╯"));
    expect(noteBottomIndex).toBeGreaterThanOrEqual(0);
    expect(lines[noteBottomIndex + 1]).toContain("export const add = true;");
    expect(lines[noteBottomIndex + 1]?.trim()).not.toBe("│");

    const changedLine = lines.find((line) => line.includes("export const alpha = 2;"));
    const annotatedLine = lines.find((line) => line.includes("export const add = true;"));
    expect(changedLine).toBeDefined();
    expect(annotatedLine).toBeDefined();
    expect(changedLine?.indexOf("+ export const")).toBe(annotatedLine?.indexOf("+ export const"));
  });

  test("DiffPane shows all inline notes when a hunk has multiple notes", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const file = bootstrap.changeset.files[0]!;
    file.agent = {
      ...file.agent!,
      annotations: [
        {
          newRange: [2, 2],
          summary: "First note",
          rationale: "First rationale.",
        },
        {
          newRange: [2, 2],
          summary: "Second note",
          rationale: "Second rationale.",
        },
      ],
    };

    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={88}
        files={bootstrap.changeset.files}
        headerLabelWidth={48}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={84}
        showAgentNotes={true}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={92}
        onSelectFile={() => {}}
      />,
      96,
      24,
    );

    expect(frame).toContain("Agent note 1/2");
    expect(frame).toContain("Agent note 2/2");
    expect(frame).toContain("First note");
    expect(frame).toContain("First rationale.");
    expect(frame).toContain("Second note");
    expect(frame).toContain("Second rationale.");
  });

  test("MenuDropdown renders checked items and key hints", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <MenuDropdown
        activeMenuId="view"
        activeMenuEntries={[
          { kind: "item", label: "Split view", hint: "1", checked: true, action: () => {} },
          { kind: "item", label: "Stacked view", hint: "2", checked: false, action: () => {} },
          { kind: "item", label: "Line numbers", hint: "l", checked: true, action: () => {} },
          { kind: "item", label: "Line wrapping", hint: "w", checked: false, action: () => {} },
          { kind: "item", label: "Hunk metadata", hint: "m", checked: true, action: () => {} },
        ]}
        activeMenuItemIndex={0}
        activeMenuSpec={{ id: "view", left: 2, width: 6, label: "View" }}
        activeMenuWidth={24}
        terminalWidth={30}
        theme={theme}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
      />,
      30,
      8,
    );

    expect(frame).toContain("[x] Split view");
    expect(frame).toContain("[ ] Stacked view");
    expect(frame).toContain("[x] Line numbers");
    expect(frame).toContain("[ ] Line wrapping");
    expect(frame).toContain("[x] Hunk metadata");
    expect(frame).toContain("1");
    expect(frame).toContain("2");
    expect(frame).toContain("l");
    expect(frame).toContain("w");
    expect(frame).toContain("m");
  });

  test("MenuDropdown repositions wide menus to stay inside the terminal", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <MenuDropdown
        activeMenuId="agent"
        activeMenuEntries={[
          { kind: "item", label: "Next annotated file", action: () => {} },
          { kind: "item", label: "Previous annotated file", action: () => {} },
        ]}
        activeMenuItemIndex={0}
        activeMenuSpec={{ id: "agent", left: 22, width: 7, label: "Agent" }}
        activeMenuWidth={30}
        terminalWidth={34}
        theme={theme}
        onHoverItem={() => {}}
        onSelectItem={() => {}}
      />,
      34,
      6,
    );

    expect(frame).toContain("Next annotated file");
    expect(frame).toContain("Previous annotated file");
    expect(frame).toContain("┐");
    expect(frame).toContain("┘");
  });

  test("StatusBar renders filter mode affordance", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <StatusBar
        filter="beta"
        filterFocused={true}
        terminalWidth={60}
        theme={theme}
        onCloseMenu={() => {}}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
      />,
      60,
      3,
    );

    expect(frame).toContain("filter:");
    expect(frame).toContain("beta");
  });

  test("StatusBar renders a notice when no filter is active", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <StatusBar
        filter=""
        filterFocused={false}
        noticeText="Update available: 9.9.9 • npm i -g hunkdiff"
        terminalWidth={60}
        theme={theme}
        onCloseMenu={() => {}}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
      />,
      60,
      3,
    );

    expect(frame).toContain("Update available: 9.9.9");
  });

  test("StatusBar keeps filter input precedence over a notice", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <StatusBar
        filter="beta"
        filterFocused={true}
        noticeText="Update available: 9.9.9 • npm i -g hunkdiff"
        terminalWidth={60}
        theme={theme}
        onCloseMenu={() => {}}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
      />,
      60,
      3,
    );

    expect(frame).toContain("filter:");
    expect(frame).toContain("beta");
    expect(frame).not.toContain("Update available:");
  });

  test("StatusBar keeps filter summary precedence over a notice", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <StatusBar
        filter="beta"
        filterFocused={false}
        noticeText="Update available: 9.9.9 • npm i -g hunkdiff"
        terminalWidth={60}
        theme={theme}
        onCloseMenu={() => {}}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
      />,
      60,
      3,
    );

    expect(frame).toContain("filter=beta");
    expect(frame).not.toContain("Update available:");
  });

  test("HelpDialog renders every documented control row without overlap", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <HelpDialog
        canRefresh={true}
        terminalHeight={39}
        terminalWidth={76}
        theme={theme}
        onClose={() => {}}
      />,
      76,
      39,
    );

    const expectedRows = [
      "Controls help",
      "[Esc]",
      "Navigation",
      "↑ / ↓           move line-by-line",
      "Space / f       page down (alt: f)",
      "b               page up",
      "Shift+Space     page up (alt)",
      "d / u           half page down / up",
      "[ / ]           previous / next hunk",
      ", / .           previous / next file",
      "{ / }           previous / next comment",
      "← / →           scroll code left / right (Shift = faster)",
      "Home / End      jump to top / bottom",
      "g / G           jump to top / bottom (less-style)",
      "Mouse",
      "Wheel           scroll vertically",
      "Shift+Wheel     scroll code horizontally",
      "View",
      "1 / 2 / 0       split / stack / auto",
      "s / t           sidebar / theme",
      "a               toggle AI notes",
      "z               toggle unchanged context",
      "l / w / m       lines / wrap / metadata",
      "e               open file in $EDITOR",
      "Review",
      "/               focus file filter",
      "c               create review note",
      "Tab             toggle files/filter focus",
      "F10             open menus",
      "r / q           reload / quit",
    ] as const;

    for (const expectedRow of expectedRows) {
      expect(frame).toContain(expectedRow);
    }

    const lines = frame.split("\n");
    const blankModalRow = /│\s+│/;
    const mouseHeaderIndex = lines.findIndex((line) => line.includes("│ Mouse"));
    const viewHeaderIndex = lines.findIndex((line) => line.includes("│ View"));
    const reviewHeaderIndex = lines.findIndex((line) => line.includes("│ Review"));

    expect(lines[mouseHeaderIndex - 1]).toMatch(blankModalRow);
    expect(lines[viewHeaderIndex - 1]).toMatch(blankModalRow);
    expect(lines[reviewHeaderIndex - 1]).toMatch(blankModalRow);
    expect(frame).not.toContain("linese/Awrapt/smetadata");
    expect(frame).not.toContain("reloade/uquit");
  });

  test("DiffSectionPlaceholder preserves offscreen section chrome without mounting rows", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffSectionPlaceholder
        bodyHeight={6}
        file={bootstrap.changeset.files[0]!}
        headerLabelWidth={40}
        headerStatsWidth={16}
        separatorWidth={68}
        showHeader={true}
        showSeparator={true}
        theme={theme}
        onSelect={() => {}}
      />,
      80,
      10,
    );

    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("+2");
    expect(frame).toContain("-1");
    expect(frame).not.toContain("export const alpha = 2;");
  });

  test("DiffPane renders an empty-state message when no files are visible", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={72}
        files={[]}
        headerLabelWidth={40}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId={undefined}
        selectedHunkIndex={0}
        separatorWidth={68}
        showAgentNotes={false}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={76}
        onSelectFile={() => {}}
      />,
      80,
      10,
    );

    expect(frame).toContain("No files match the current filter.");
  });

  test("DiffPane can hide line numbers while keeping diff signs visible", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={72}
        files={bootstrap.changeset.files}
        headerLabelWidth={40}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={68}
        showAgentNotes={false}
        showLineNumbers={false}
        showHunkHeaders={true}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={76}
        onSelectFile={() => {}}
      />,
      80,
      18,
    );

    expect(frame).not.toContain("1 - export const alpha = 1;");
    expect(frame).not.toContain("1 + export const alpha = 2;");
    expect(frame).toContain("- export const alpha = 1;");
    expect(frame).toContain("+ export const alpha = 2;");
  });

  test("DiffPane can wrap long diff lines onto continuation rows", async () => {
    const bootstrap = createWrapBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={48}
        files={bootstrap.changeset.files}
        headerLabelWidth={24}
        headerStatsWidth={12}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="wrap"
        selectedHunkIndex={0}
        separatorWidth={44}
        showAgentNotes={false}
        showLineNumbers={true}
        showHunkHeaders={true}
        wrapLines={true}
        wrapToggleScrollTop={null}
        theme={theme}
        width={52}
        onSelectFile={() => {}}
      />,
      56,
      20,
    );

    expect(frame).toContain("1 + export const messag");
    expect(frame).toContain("e = 'this is a very");
    expect(frame).toContain("long wrapped line");
    expect(frame).toContain("coverage';");
  });

  test("DiffPane can hide hunk metadata rows without hiding code lines", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        diffContentWidth={72}
        files={bootstrap.changeset.files}
        headerLabelWidth={40}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId="alpha"
        selectedHunkIndex={0}
        separatorWidth={68}
        showAgentNotes={false}
        showLineNumbers={true}
        showHunkHeaders={false}
        wrapLines={false}
        wrapToggleScrollTop={null}
        theme={theme}
        width={76}
        onSelectFile={() => {}}
      />,
      80,
      18,
    );

    expect(frame).not.toContain("@@ -1,1 +1,2 @@");
    expect(frame).not.toContain("@@ -1,1 +1,1 @@");
    expect(frame).toContain("1 - export const alpha = 1;");
    expect(frame).toContain("1 + export const alpha = 2;");
  });

  test("PierreDiffView renders stack-mode wrapped continuation rows", async () => {
    const file = createWrapBootstrap().changeset.files[0]!;
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="stack"
        theme={theme}
        width={48}
        selectedHunkIndex={0}
        wrapLines={true}
        scrollable={false}
      />,
      52,
      18,
    );

    const addedLines = frame
      .split("\n")
      .filter(
        (line) =>
          line.includes("export const message = 'this is a very") || /^▌\s{6,}\S/.test(line),
      );

    expect(frame).toContain("1   -  export const message = 'short';");
    expect(addedLines[0]).toContain("1 +  export const message = 'this is a very l");
    expect(addedLines.length).toBeGreaterThanOrEqual(3);
    expect(addedLines.slice(1).some((line) => line.includes("ong wrapped line"))).toBe(true);
    expect(addedLines.slice(1).some((line) => line.includes("age';"))).toBe(true);
  });

  test("PierreDiffView can reveal offscreen code columns in nowrap mode", async () => {
    const file = createWrapBootstrap().changeset.files[0]!;
    const theme = resolveTheme("midnight", null);

    const baseFrame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="stack"
        theme={theme}
        width={48}
        selectedHunkIndex={0}
        wrapLines={false}
        scrollable={false}
      />,
      52,
      12,
    );
    const shiftedFrame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="stack"
        theme={theme}
        width={48}
        selectedHunkIndex={0}
        wrapLines={false}
        codeHorizontalOffset={48}
        scrollable={false}
      />,
      52,
      12,
    );

    expect(baseFrame).toContain("this is a very");
    expect(baseFrame).not.toContain("diff rendering coverage';");
    expect(shiftedFrame).toContain("coverage';");
    expect(shiftedFrame).not.toContain("this is a very");
  });

  test("split view wraps the same long diff line across more rows than stack view at the same width", async () => {
    const file = createWrapBootstrap().changeset.files[0]!;
    const theme = resolveTheme("midnight", null);
    const width = 64;

    const splitFrame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={width}
        selectedHunkIndex={0}
        wrapLines={true}
        scrollable={false}
      />,
      width + 4,
      18,
    );
    const stackFrame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="stack"
        theme={theme}
        width={width}
        selectedHunkIndex={0}
        wrapLines={true}
        scrollable={false}
      />,
      width + 4,
      18,
    );

    const splitContinuationRows = splitFrame.split("\n").filter((line) => /^▌\s+▌\s+\S/.test(line));
    const stackContinuationRows = stackFrame.split("\n").filter((line) => /^▌\s{6,}\S/.test(line));

    expect(splitFrame).toContain("1 + export const message = 't");
    expect(stackFrame).toContain("1 +  export const message = 'this is a very long wrapped line");
    expect(splitContinuationRows.length).toBeGreaterThan(stackContinuationRows.length);
  });

  test("PierreDiffView anchors range-less notes to the first visible row when hunk headers are hidden", async () => {
    const file = createTestDiffFile(
      "note-fallback",
      "note-fallback.ts",
      "export const value = 1;\n",
      "export const value = 2;\nexport const added = true;\n",
    );
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={88}
        selectedHunkIndex={0}
        visibleAgentNotes={[
          {
            id: "note:ungrounded",
            annotation: {
              summary: "Ungrounded note",
              rationale: "Falls back to the first visible row.",
            },
          },
        ]}
        showHunkHeaders={false}
        scrollable={false}
      />,
      92,
      18,
    );

    expect(frame).not.toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("Agent note - note-fallback.ts hunk");
    expect(frame).toContain("Ungrounded note");
    expect(frame).toContain("Falls back to the first visible");
    expect(frame).toContain("row.");
    expect(frame.indexOf("Agent note - note-fallback.ts hunk")).toBeLessThan(
      frame.indexOf("1 - export const value = 1;"),
    );
  });

  test("PierreDiffView shows contextual messages when there is no selected file or no textual hunks", async () => {
    const theme = resolveTheme("midnight", null);

    const noFileFrame = await captureFrame(
      <PierreDiffView
        file={undefined}
        layout="split"
        theme={theme}
        width={72}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      76,
      6,
    );
    expect(noFileFrame).toContain("No file selected.");

    const renameOnlyFrame = await captureFrame(
      <PierreDiffView
        file={createEmptyDiffFile("rename-pure")}
        layout="split"
        theme={theme}
        width={72}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      76,
      6,
    );
    expect(renameOnlyFrame).toContain("This change only renames the file.");

    const newFileFrame = await captureFrame(
      <PierreDiffView
        file={createEmptyDiffFile("new")}
        layout="split"
        theme={theme}
        width={72}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      76,
      6,
    );
    expect(newFileFrame).toContain("The file is marked as new.");

    const deletedFileFrame = await captureFrame(
      <PierreDiffView
        file={createEmptyDiffFile("deleted")}
        layout="split"
        theme={theme}
        width={72}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      76,
      6,
    );
    expect(deletedFileFrame).toContain("The file is marked as deleted.");

    const binaryFileFrame = await captureFrame(
      <PierreDiffView
        file={{
          ...createEmptyDiffFile("change"),
          id: "empty:binary",
          isBinary: true,
          path: "image.png",
        }}
        layout="split"
        theme={theme}
        width={72}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      76,
      6,
    );
    expect(binaryFileFrame).toContain("Binary file skipped");
  });

  test("PierreDiffView shows the expand chevron only when a source fetcher is attached", async () => {
    const { file: baseFile } = createExpandableContextDiffFile("expand-affordance", "expand.ts");
    const theme = resolveTheme("midnight", null);

    const noFetcherFrame = await captureFrame(
      <PierreDiffView
        file={baseFile}
        layout="split"
        theme={theme}
        width={120}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      120,
      40,
    );
    expect(noFetcherFrame).toContain("unchanged lines");
    expect(noFetcherFrame).not.toContain("▾");

    const fileWithFetcher = {
      ...baseFile,
      sourceFetcher: createTestSourceFetcher(() => null),
    };

    const expandableFrame = await captureFrame(
      <PierreDiffView
        file={fileWithFetcher}
        layout="split"
        theme={theme}
        width={120}
        selectedHunkIndex={0}
        scrollable={false}
        onToggleGap={() => {}}
      />,
      120,
      40,
    );
    expect(expandableFrame).toContain("▾");
  });

  test("PierreDiffView hides add-note affordances on collapsed and hunk-header rows", async () => {
    const expandable = createExpandableContextDiffFile("meta-hover", "meta-hover.ts");
    const file = {
      ...expandable.file,
      sourceFetcher: createTestSourceFetcher(() => expandable.after),
    };
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={120}
        selectedHunkIndex={0}
        scrollable={false}
        onStartUserNoteAtHunk={() => {}}
        onToggleGap={() => {}}
      />,
      { width: 120, height: 40 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      const frame = setup.captureCharFrame();
      const frameLines = frame.split("\n");
      const collapsedY = frameLines.findIndex((line) => line.includes("unchanged lines"));
      const hunkHeaderY = frameLines.findIndex((line) => line.includes("@@"));
      const codeY = frameLines.findIndex((line) => line.includes("line 5 modified"));
      expect(collapsedY).toBeGreaterThanOrEqual(0);
      expect(hunkHeaderY).toBeGreaterThanOrEqual(0);
      expect(codeY).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup.mockMouse.moveTo(4, collapsedY);
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame()).not.toContain("[+]");

      await act(async () => {
        await setup.mockMouse.moveTo(4, hunkHeaderY);
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame()).not.toContain("[+]");

      let codeHoverFrame = "";
      for (const y of [codeY, codeY + 1]) {
        for (const x of [4, 16, 48, 76]) {
          await act(async () => {
            await setup.mockMouse.moveTo(x, y);
            await setup.renderOnce();
          });
          codeHoverFrame = setup.captureCharFrame();
          if (codeHoverFrame.includes("[+]")) {
            break;
          }
        }
        if (codeHoverFrame.includes("[+]")) {
          break;
        }
      }
      expect(codeHoverFrame).toContain("[+]");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("PierreDiffView toggles a collapsed gap when clicked", async () => {
    const expandable = createExpandableContextDiffFile("expand-click", "expand-click.ts");
    const file = {
      ...expandable.file,
      sourceFetcher: createTestSourceFetcher(() => expandable.after),
    };
    const toggledGaps: string[] = [];
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={120}
        selectedHunkIndex={0}
        scrollable={false}
        onToggleGap={(gapKey) => {
          toggledGaps.push(gapKey);
        }}
      />,
      { width: 120, height: 40 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      const frame = setup.captureCharFrame();
      const gapLineIndex = frame.split("\n").findIndex((line) => line.includes("▾"));
      expect(gapLineIndex).toBeGreaterThanOrEqual(0);

      for (const y of [gapLineIndex, gapLineIndex + 1]) {
        for (const x of [2, 8, 24]) {
          await act(async () => {
            await setup.mockMouse.click(x, y);
          });
          if (toggledGaps.length > 0) {
            break;
          }
        }
        if (toggledGaps.length > 0) {
          break;
        }
      }

      expect(toggledGaps).toEqual(["before:0"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("PierreDiffView highlights expanded unchanged source rows", async () => {
    const beforeLines = Array.from({ length: 30 }, (_, index) =>
      index === 0
        ? "export const expandedMarker = 1;"
        : `export const line${index + 1} = ${index + 1};`,
    );
    const afterLines = [...beforeLines];
    afterLines[4] = "export const line5 = 999;";
    const after = lines(...afterLines);
    const file = buildTestDiffFile({
      after,
      before: lines(...beforeLines),
      context: 3,
      id: "expanded-highlight",
      path: "expanded-highlight.ts",
    });
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={140}
        selectedHunkIndex={0}
        expandedGapKeys={new Set(["before:0"])}
        sourceStatus={{ kind: "loaded", text: after }}
        scrollable={false}
      />,
      { width: 144, height: 20 },
    );

    try {
      let highlighted = false;
      for (let iteration = 0; iteration < 400; iteration += 1) {
        await act(async () => {
          await setup.renderOnce();
          await Bun.sleep(0);
          await setup.renderOnce();
          await Bun.sleep(0);
        });

        if (frameHasHighlightedMarker(setup.captureSpans(), "expandedMarker")) {
          highlighted = true;
          break;
        }
      }

      expect(highlighted).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("PierreDiffView renders word-diff spans with a visibly different background in split view", async () => {
    const file = createTestDiffFile(
      "word-diff",
      "word-diff.ts",
      "export const answer = 41;\nexport const stable = true;\n",
      "export const answer = 42;\nexport const stable = true;\n",
    );
    const theme = resolveTheme("graphite", null);
    const setup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={120}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      { width: 124, height: 10 },
    );

    try {
      let removedBackgroundDistance: number | null = null;
      let addedBackgroundDistance: number | null = null;

      for (let iteration = 0; iteration < 200; iteration += 1) {
        await act(async () => {
          await setup.renderOnce();
          await Bun.sleep(0);
          await setup.renderOnce();
          await Bun.sleep(0);
        });

        const frame = setup.captureSpans();
        removedBackgroundDistance = renderedWordDiffBackgroundDistance(frame, "41");
        addedBackgroundDistance = renderedWordDiffBackgroundDistance(frame, "42");

        if (
          removedBackgroundDistance !== null &&
          addedBackgroundDistance !== null &&
          removedBackgroundDistance > 0 &&
          addedBackgroundDistance > 0
        ) {
          break;
        }
      }

      expect(removedBackgroundDistance).toBeGreaterThanOrEqual(28);
      expect(addedBackgroundDistance).toBeGreaterThanOrEqual(28);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("PierreDiffView reuses highlighted rows after unmounting and remounting a file section", async () => {
    const file = createTestDiffFile(
      "cache",
      "cache.ts",
      "export const cacheMarker = 1;\nexport function cacheKeep(value: number) { return value + 1; }\n",
      "export const cacheMarker = 2;\nexport function cacheKeep(value: number) { return value * 2; }\n",
    );
    const theme = resolveTheme("midnight", null);

    const firstSetup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={180}
        selectedHunkIndex={0}
        scrollable={false}
      />,
      { width: 184, height: 10 },
    );

    try {
      let ready = false;
      for (let iteration = 0; iteration < 400; iteration += 1) {
        await act(async () => {
          await firstSetup.renderOnce();
          await Bun.sleep(0);
          await firstSetup.renderOnce();
          await Bun.sleep(0);
        });

        if (frameHasHighlightedMarker(firstSetup.captureSpans(), "cacheMarker")) {
          ready = true;
          break;
        }
      }

      expect(ready).toBe(true);
    } finally {
      await act(async () => {
        firstSetup.renderer.destroy();
      });
    }

    const secondSetup = await testRender(
      <PierreDiffView
        file={file}
        layout="split"
        theme={theme}
        width={180}
        selectedHunkIndex={0}
        shouldLoadHighlight={false}
        scrollable={false}
      />,
      { width: 184, height: 10 },
    );

    try {
      await act(async () => {
        await secondSetup.renderOnce();
      });

      expect(frameHasHighlightedMarker(secondSetup.captureSpans(), "cacheMarker")).toBe(true);
    } finally {
      await act(async () => {
        secondSetup.renderer.destroy();
      });
    }
  });

  test("DiffPane prefetches highlight data for files approaching the viewport before they mount", async () => {
    const files = createHighlightPrefetchWindowFiles();
    const theme = resolveTheme("midnight", null);
    const setup = await testRender(
      <DiffPane
        {...createDiffPaneProps(files, theme, {
          diffContentWidth: 92,
          separatorWidth: 88,
          width: 96,
        })}
      />,
      { width: 100, height: 10 },
    );
    const thirdFileCheck = await testRender(
      <PierreDiffView
        file={files[2]}
        layout="split"
        theme={theme}
        width={180}
        selectedHunkIndex={0}
        shouldLoadHighlight={false}
        scrollable={false}
      />,
      { width: 184, height: 10 },
    );

    try {
      await settleDiffPane(setup);

      const initialFrame = setup.captureCharFrame();
      expect(initialFrame).not.toContain("prefetch-3.ts");

      let prefetched = false;
      for (let iteration = 0; iteration < 400; iteration += 1) {
        await act(async () => {
          await setup.renderOnce();
          await thirdFileCheck.renderOnce();
          await Bun.sleep(0);
          await setup.renderOnce();
          await thirdFileCheck.renderOnce();
          await Bun.sleep(0);
        });

        if (frameHasHighlightedMarker(thirdFileCheck.captureSpans(), "prefetchMarker3")) {
          prefetched = true;
          break;
        }
      }

      expect(prefetched).toBe(true);
    } finally {
      await act(async () => {
        thirdFileCheck.renderer.destroy();
        setup.renderer.destroy();
      });
    }
  });

  test("App renders the menu bar and multi-file stream", async () => {
    const bootstrap = createBootstrap();
    const frame = await captureFrame(<AppHost bootstrap={bootstrap} />, 280, 24);

    expect(frame).toContain("File  View  Navigate  Theme  Agent  Help");
    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).not.toContain("[AI]");
    expect(frame).not.toContain("Changeset summary");
  });
});
