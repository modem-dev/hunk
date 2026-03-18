import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act, createRef, type ReactNode } from "react";
import type { AppBootstrap, DiffFile } from "../src/core/types";
import { resolveTheme } from "../src/ui/themes";

const { App } = await import("../src/ui/App");
const { HelpDialog } = await import("../src/ui/components/chrome/HelpDialog");
const { FilesPane } = await import("../src/ui/components/panes/FilesPane");
const { DiffPane } = await import("../src/ui/components/panes/DiffPane");
const { MenuDropdown } = await import("../src/ui/components/chrome/MenuDropdown");
const { StatusBar } = await import("../src/ui/components/chrome/StatusBar");

function createDiffFile(id: string, path: string, before: string, after: string, withAgent = false): DiffFile {
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
        createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\nexport const add = true;\n", true),
        createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const betaValue = 1;\n", false),
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
        focused={true}
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
        activeAnnotations={[]}
        diffContentWidth={72}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
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

  test("DiffPane renders hunk notes with file and line labels only", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        activeAnnotations={bootstrap.changeset.files[0]?.agent?.annotations ?? []}
        diffContentWidth={88}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      96,
      18,
    );

    expect(frame).toContain("alpha.ts +2");
    expect(frame).toContain("Annotation for alpha.ts");
    expect(frame).toContain("Why alpha.ts changed");
    expect(frame).not.toContain("alpha.ts note");
    expect(frame).not.toContain("review");
    expect(frame).not.toContain("confidence");
    expect(frame).toContain("[x]");
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
    const frame = await captureFrame(<HelpDialog left={2} theme={theme} width={68} onClose={() => {}} />, 76, 14);

    expect(frame).toContain("Keyboard");
    expect(frame).toContain("F10 menus");
    expect(frame).toContain("drag the Files/Diff divider");
  });

  test("DiffPane renders an empty-state message when no files are visible", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        activeAnnotations={[]}
        diffContentWidth={72}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
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
        activeAnnotations={[]}
        diffContentWidth={72}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
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
        activeAnnotations={[]}
        diffContentWidth={48}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
        onOpenAgentNotesAtHunk={() => {}}
        onSelectFile={() => {}}
      />,
      56,
      20,
    );

    expect(frame).toContain("1 + export const messag");
    expect(frame).toContain("e = 'this is a very");
    expect(frame).toContain("long wrapped line");
    expect(frame).toContain("for diff rendering");
  });

  test("DiffPane can hide hunk metadata rows without hiding code lines", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <DiffPane
        activeAnnotations={[]}
        diffContentWidth={72}
        dismissedAgentNoteIds={[]}
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
        onDismissAgentNote={() => {}}
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
