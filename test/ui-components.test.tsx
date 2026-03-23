import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act, createRef, type ReactNode } from "react";
import type { AppBootstrap, DiffFile } from "../src/core/types";
import { resolveTheme } from "../src/ui/themes";

const { App } = await import("../src/ui/App");
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
  test("FilesPane renders file rows and diff stats", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <FilesPane
        entries={bootstrap.changeset.files.map((file) => ({
          id: file.id,
          label: `M ${file.path}`,
          description: `+${file.stats.additions}  -${file.stats.deletions}${file.agent ? "  agent" : ""}`,
        }))}
        scrollRef={createRef()}
        selectedFileId="alpha"
        textWidth={24}
        theme={theme}
        width={28}
        onSelectFile={() => {}}
      />,
      32,
      12,
    );

    expect(frame).toContain("M alpha.ts");
    expect(frame).toContain("+2  -1  agent");
    expect(frame).toContain("M beta.ts");
    expect(frame).toContain("+1  -1");
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

  test("AgentInlineNote renders a connected bordered panel with an indented connector", async () => {
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
      6,
    );

    const lines = frame.split("\n");
    expect(lines[0]?.trimStart().startsWith("┌")).toBe(true);
    expect(lines[1]).toContain("AI note · ▶ new 2-4");
    expect(lines[1]).toContain("[x]");
    expect(lines[2]).toContain("Summary line");
    expect(lines[3]).toContain("Rationale line.");
    expect(lines[4]?.trimStart().startsWith("└")).toBe(true);
    expect(lines[5]?.trimStart().startsWith("│")).toBe(true);
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

  test("HelpDialog renders the keyboard help copy", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <HelpDialog left={2} theme={theme} width={68} onClose={() => {}} />,
      76,
      14,
    );

    expect(frame).toContain("Keyboard");
    expect(frame).toContain("F10 menus");
    expect(frame).toContain("drag the Files/Diff divider");
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
    const frame = await captureFrame(<App bootstrap={bootstrap} />, 280, 24);

    expect(frame).toContain("File  View  Navigate  Theme  Agent  Help");
    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).toContain("[AI]");
    expect(frame).not.toContain("Changeset summary");
  });
});
