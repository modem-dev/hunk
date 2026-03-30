import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act, createRef, type ReactNode } from "react";
import type { AppBootstrap, DiffFile } from "../src/core/types";
import { resolveTheme } from "../src/ui/themes";

const { AppHost } = await import("../src/ui/AppHost");
const { buildSidebarEntries } = await import("../src/ui/lib/files");
const { HelpDialog } = await import("../src/ui/components/chrome/HelpDialog");
const { FilesPane } = await import("../src/ui/components/panes/FilesPane");
const { AgentCard } = await import("../src/ui/components/panes/AgentCard");
const { AgentInlineNote } = await import("../src/ui/components/panes/AgentInlineNote");
const { DiffPane } = await import("../src/ui/components/panes/DiffPane");
const { MenuDropdown } = await import("../src/ui/components/chrome/MenuDropdown");
const { StatusBar } = await import("../src/ui/components/chrome/StatusBar");
const { DiffSectionPlaceholder } =
  await import("../src/ui/components/panes/DiffSectionPlaceholder");
const { PierreDiffView } = await import("../src/ui/diff/PierreDiffView");

function createDiffFile(
  id: string,
  path: string,
  before: string,
  after: string,
  withAgent = false,
): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `${id}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `${id}:after`,
    },
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
    stats: {
      additions,
      deletions,
    },
    metadata,
    agent: withAgent
      ? {
          path,
          summary: `${path} note`,
          annotations: [
            {
              newRange: [2, 2],
              summary: `Annotation for ${path}`,
              rationale: `Why ${path} changed`,
              tags: ["review"],
              confidence: "high",
            },
          ],
        }
      : null,
  };
}

function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

function createWindowingFiles(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createDiffFile(
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

  return createDiffFile(id, path, before, after);
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

  return createDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
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

  return createDiffFile(id, path, lines(...beforeLines), lines(...afterLines));
}

function createDiffPaneProps(
  files: DiffFile[],
  theme = resolveTheme("midnight", null),
  overrides: Partial<Parameters<typeof DiffPane>[0]> = {},
) {
  return {
    activeAnnotations: [],
    diffContentWidth: 72,
    dismissedAgentNoteIds: [],
    files,
    headerLabelWidth: 40,
    headerStatsWidth: 16,
    layout: "split" as const,
    scrollRef: createRef(),
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
    onDismissAgentNote: () => {},
    onOpenAgentNotesAtHunk: () => {},
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

function createBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: "changeset:ui",
      sourceLabel: "repo",
      title: "repo working tree",
      summary: "Patch summary",
      agentSummary: "Changeset summary",
      files: [
        createDiffFile(
          "alpha",
          "alpha.ts",
          "export const alpha = 1;\n",
          "export const alpha = 2;\nexport const add = true;\n",
          true,
        ),
        createDiffFile(
          "beta",
          "beta.ts",
          "export const beta = 1;\n",
          "export const betaValue = 1;\n",
          false,
        ),
      ],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

function createWrapBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "split",
      },
    },
    changeset: {
      id: "changeset:wrap",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [
        createDiffFile(
          "wrap",
          "wrap.ts",
          "export const message = 'short';\n",
          "export const message = 'this is a very long wrapped line for diff rendering coverage';\n",
        ),
      ],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

function createEmptyDiffFile(type: "rename-pure" | "new" | "deleted"): DiffFile {
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

describe("UI components", () => {
  test("FilesPane renders grouped file rows with indented filenames and right-aligned stats", async () => {
    const theme = resolveTheme("midnight", null);
    const files = [
      createDiffFile(
        "app",
        "src/ui/App.tsx",
        "export const app = 1;\n",
        "export const app = 2;\nexport const view = true;\n",
        true,
      ),
      createDiffFile(
        "menu",
        "src/ui/MenuDropdown.tsx",
        "export const menu = 1;\n",
        "export const menu = 2;\n",
      ),
      createDiffFile(
        "watch",
        "src/core/watch.ts",
        "export const watch = 1;\n",
        "export const watch = 2;\nexport const enabled = true;\n",
      ),
    ];
    const frame = await captureFrame(
      <FilesPane
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
    expect(frame).toContain("+2 -1");
    expect(frame).toContain("+1 -1");
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
        theme={theme}
        width={76}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      80,
      18,
    );

    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).toContain("[AI]");
    expect(frame.indexOf("alpha.ts")).toBeLessThan(frame.indexOf("beta.ts"));
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
      const frame = setup.captureCharFrame();

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
      createDiffFile(
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
      expect(frame).toContain("export const line19 = 19;");
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

      expect(frame).toContain("Keep the selected hunk visible with its note.");
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

    const file = createDiffFile(
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
    expect(lines[0]?.trimStart().startsWith("┌")).toBe(true);
    expect(lines[1]).toContain("AI note · ▶ new 2-4");
    expect(lines[1]).toContain("[x]");
    expect(lines[2]).toContain("Summary line");
    expect(lines[3]).toContain("Rationale line.");
    expect(lines[4]?.trimStart().startsWith("└")).toBe(true);
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
        theme={theme}
        width={92}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      96,
      28,
    );

    expect(frame).toContain("AI note · ▶ new 2");
    expect(frame).toContain("Annotation for alpha.ts");
    expect(frame).toContain("Why alpha.ts changed");
    expect(frame.indexOf("AI note · ▶ new 2")).toBeLessThan(
      frame.indexOf("2 + export const add = true;"),
    );
    expect(frame).toContain("AI note · ▶ new 1");
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
        theme={theme}
        width={92}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      96,
      16,
    );

    const lines = frame.split("\n");
    const noteBottomIndex = lines.findIndex((line) => line.includes("└") && line.includes("┤"));
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
        theme={theme}
        width={92}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      96,
      24,
    );

    expect(frame).toContain("AI note 1/2");
    expect(frame).toContain("AI note 2/2");
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

  test("HelpDialog renders every keyboard shortcut row without overlap", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <HelpDialog
        canRefresh={true}
        terminalHeight={29}
        terminalWidth={76}
        theme={theme}
        onClose={() => {}}
      />,
      76,
      29,
    );

    const expectedRows = [
      "Keyboard help",
      "[Esc]",
      "Navigation",
      "↑ / ↓           move line-by-line",
      "Space / f       page down (alt: f)",
      "b               page up",
      "Shift+Space     page up (alt)",
      "d / u           half page down / up",
      "[ / ]           previous / next hunk",
      "{ / }           previous / next comment",
      "Home / End      jump to top / bottom",
      "View",
      "1 / 2 / 0       split / stack / auto",
      "s / t           sidebar / theme",
      "a               toggle AI notes",
      "l / w / m       lines / wrap / metadata",
      "Review",
      "/               focus file filter",
      "Tab             toggle files/filter focus",
      "F10             open menus",
      "r / q           reload / quit",
    ] as const;

    for (const expectedRow of expectedRows) {
      expect(frame).toContain(expectedRow);
    }

    const lines = frame.split("\n");
    const blankModalRow = /│\s+│/;
    const viewHeaderIndex = lines.findIndex((line) => line.includes("│ View"));
    const reviewHeaderIndex = lines.findIndex((line) => line.includes("│ Review"));

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
        theme={theme}
        width={76}
        onOpenAgentNotesAtHunk={() => {}}
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
        theme={theme}
        width={76}
        onOpenAgentNotesAtHunk={() => {}}
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
        theme={theme}
        width={52}
        onOpenAgentNotesAtHunk={() => {}}
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
        theme={theme}
        width={76}
        onOpenAgentNotesAtHunk={() => {}}
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
    const file = createDiffFile(
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
    expect(frame).toContain("AI note · hunk");
    expect(frame).toContain("Ungrounded note");
    expect(frame).toContain("Falls back to the first visible");
    expect(frame).toContain("row.");
    expect(frame.indexOf("AI note · hunk")).toBeLessThan(
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
  });

  test("PierreDiffView reuses highlighted rows after unmounting and remounting a file section", async () => {
    const file = createDiffFile(
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

  test("App renders the menu bar, multi-file stream, and AI badges", async () => {
    const bootstrap = createBootstrap();
    const frame = await captureFrame(<AppHost bootstrap={bootstrap} />, 280, 24);

    expect(frame).toContain("File  View  Navigate  Theme  Agent  Help");
    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).toContain("[AI]");
    expect(frame).not.toContain("Changeset summary");
  });
});
