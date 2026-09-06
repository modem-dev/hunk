import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionFileView,
  HunkExtensionAPI,
} from "../packages/hunk/src/extension-api/types";
import renderedMarkdownExtension from "../examples/extensions/rendered-markdown";

function registerMarkdownTestView() {
  let view: ExtensionFileView | undefined;
  let command: ExtensionCommand | undefined;
  let commandHandler: ExtensionCommandHandler | undefined;
  renderedMarkdownExtension({
    registerCommand(candidate: ExtensionCommand, handler: ExtensionCommandHandler) {
      command = candidate;
      commandHandler = handler;
    },
    registerFileView(candidate: ExtensionFileView) {
      view = candidate;
    },
  } as HunkExtensionAPI);
  return { view: view!, command: command!, commandHandler: commandHandler! };
}

describe("rendered Markdown example extension", () => {
  test("uses only the public contract and renders Markdown syntax into symbolic rows", async () => {
    const { view, command, commandHandler } = registerMarkdownTestView();
    expect(command).toMatchObject({
      id: "toggle-rendered-markdown",
      key: "f8",
    });
    const toggled: string[] = [];
    commandHandler({
      fileViews: { toggle: (viewId: string) => toggled.push(viewId) },
    } as never);
    expect(toggled).toEqual(["rendered-markdown"]);
    expect(
      view.matches({
        path: "README.md",
        isBinary: false,
        isTooLarge: false,
      } as never),
    ).toBe(true);

    const layout = await view.layout({
      file: {
        id: "readme",
        path: "README.md",
        patch: "",
        stats: { additions: 1, deletions: 0 },
        metadata: {},
        agent: null,
        hunks: [{ index: 0, header: "@@", newRange: [2, 2] }],
      },
      width: 80,
      signal: new AbortController().signal,
      changes: [{ hunkIndex: 0, range: [2, 2], kind: "added" }],
      readDocument: async () => "# Hello\nnew item\n",
    });

    expect(layout?.rows).toEqual([
      {
        id: "rendered:0",
        spans: [{ text: "Hello", tone: "accent", attributes: ["bold"] }],
      },
      {
        id: "rendered:1",
        spans: [{ text: "new item", tone: "added" }],
        sourceRanges: [{ side: "new", range: [2, 2] }],
      },
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 1 }]);
  });

  test("renders lists, quotes, tables, inline emphasis, links, and fenced code", async () => {
    const { view } = registerMarkdownTestView();
    const layout = await view.layout({
      file: {
        id: "guide",
        path: "guide.md",
        patch: "",
        stats: { additions: 0, deletions: 0 },
        metadata: {},
        agent: null,
        hunks: [],
      },
      width: 80,
      signal: new AbortController().signal,
      changes: [],
      readDocument: async () =>
        [
          "# Guide",
          "",
          "Use **bold**, *emphasis*, and [docs](https://example.com).",
          "",
          "- first",
          "- second",
          "",
          "> quoted",
          "",
          "| A | B |",
          "|---|---|",
          "| 1 | 2 |",
          "",
          "```ts",
          "const answer = 42",
          "```",
          "",
        ].join("\n"),
    });

    const text = layout?.rows.map((row) => row.spans.map((span) => span.text).join(""));
    expect(text).toContain("Guide");
    expect(text).not.toContain("# Guide");
    expect(text).toContain("• first");
    expect(text).toContain("│ quoted");
    expect(text).toContain("A │ B");
    expect(text).toContain("┌─ ts");
    expect(text).toContain("│ const answer = 42");
    expect(text).not.toContain("```ts");
    const spans = layout?.rows.flatMap((row) => row.spans) ?? [];
    expect(spans.map((span) => span.tone)).toEqual(expect.arrayContaining(["accent", "syntax"]));
    expect(spans.flatMap((span) => span.attributes ?? [])).toEqual(
      expect.arrayContaining(["bold", "italic", "underline"]),
    );
  });

  test("falls back to raw diff for unavailable source or malformed fences", async () => {
    const { view } = registerMarkdownTestView();
    const base = {
      file: {
        id: "x",
        path: "x.md",
        patch: "",
        stats: { additions: 0, deletions: 0 },
        metadata: {},
        agent: null,
        hunks: [],
      },
      changes: [],
    } as const;
    const request = {
      ...base,
      width: 80,
      signal: new AbortController().signal,
    };
    await expect(view.layout({ ...request, readDocument: async () => null })).resolves.toBeNull();
    await expect(
      view.layout({ ...request, readDocument: async () => "```ts\nopen" }),
    ).resolves.toBeNull();
  });
});
