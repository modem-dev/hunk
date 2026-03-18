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
const { AgentRail } = await import("../src/ui/components/panes/AgentRail");
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
          annotations: [{ newRange: [2, 2], summary: `Annotation for ${path}` }],
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

    expect(frame).toContain("Files");
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
    expect(frame.indexOf("alpha.ts")).toBeLessThan(frame.indexOf("beta.ts"));
  });

  test("AgentRail renders changeset, file, annotation, and patch summaries", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentRail
        activeAnnotations={bootstrap.changeset.files[0]!.agent!.annotations}
        changesetSummary={bootstrap.changeset.summary}
        file={bootstrap.changeset.files[0]}
        marginLeft={1}
        summary={bootstrap.changeset.agentSummary}
        theme={theme}
        width={38}
      />,
      42,
      24,
    );

    expect(frame).toContain("Agent");
    expect(frame).toContain("Changeset summary");
    expect(frame).toContain("alpha.ts note");
    expect(frame).toContain("Annotation for alpha.ts");
    expect(frame).toContain("Patch");
  });

  test("AgentRail renders empty-state copy when no file metadata is attached", async () => {
    const bootstrap = createBootstrap();
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <AgentRail
        activeAnnotations={[]}
        changesetSummary={undefined}
        file={bootstrap.changeset.files[1]}
        marginLeft={1}
        summary={undefined}
        theme={theme}
        width={38}
      />,
      42,
      16,
    );

    expect(frame).toContain("Selection");
    expect(frame).toContain("No agent metadata");
  });

  test("MenuDropdown renders checked items and key hints", async () => {
    const theme = resolveTheme("midnight", null);
    const frame = await captureFrame(
      <MenuDropdown
        activeMenuId="view"
        activeMenuEntries={[
          { kind: "item", label: "Split view", hint: "1", checked: true, action: () => {} },
          { kind: "item", label: "Stacked view", hint: "2", checked: false, action: () => {} },
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
    expect(frame).toContain("1");
    expect(frame).toContain("2");
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
        diffContentWidth={72}
        files={[]}
        headerLabelWidth={40}
        headerStatsWidth={16}
        layout="split"
        scrollRef={createRef()}
        selectedFileId={undefined}
        selectedHunkIndex={0}
        separatorWidth={68}
        theme={theme}
        width={76}
        onSelectFile={() => {}}
      />,
      80,
      10,
    );

    expect(frame).toContain("No files match the current filter.");
  });

  test("App renders the menu bar, multi-file stream, and agent rail together", async () => {
    const bootstrap = createBootstrap();
    const frame = await captureFrame(<App bootstrap={bootstrap} />, 180, 24);

    expect(frame).toContain("File  View  Navigate  Theme  Agent  Help");
    expect(frame).toContain("alpha.ts");
    expect(frame).toContain("beta.ts");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("@@ -1,1 +1,1 @@");
    expect(frame).toContain("Changeset summary");
  });
});
