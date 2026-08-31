import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const RENDERED_MARKDOWN_EXTENSION = join(
  import.meta.dir,
  "../../examples/extensions/rendered-markdown",
);
const INLINE_EDIT_EXTENSION = join(import.meta.dir, "../../examples/extensions/inline-edit");
const JSX_FILE_VIEW_EXTENSION = join(import.meta.dir, "../../examples/extensions/jsx-file-view");
const JSX_FILE_VIEW_GALLERY = join(
  import.meta.dir,
  "../../examples/extensions/jsx-file-view-gallery",
);
const JSX_MIXED_REVIEW_LAUNCHER = join(JSX_FILE_VIEW_GALLERY, "mixed-review/run.ts");
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Create a direct-file Markdown diff so exact old/new source remains host-readable. */
function createMarkdownPairTest(noteRange: [number, number] = [3, 3]) {
  const directory = mkdtempSync(join(tmpdir(), "hunk-file-view-"));
  const before = join(directory, "before.md");
  const after = join(directory, "after.md");
  const agentContext = join(directory, "agent.json");
  writeFileSync(before, "# Heading\n\n- old item\n", "utf8");
  writeFileSync(after, "# Heading\n\n- new item\n", "utf8");
  writeFileSync(
    agentContext,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.md",
          annotations: [{ newRange: noteRange, summary: "Review the new item." }],
        },
      ],
    }),
    "utf8",
  );
  return { after, agentContext, before, directory };
}

/**
 * Write a file view whose interactive mode moves a highlight with `j`.
 *
 * The mode answers `j`, leaves on `x`, and declines everything else, so one real
 * terminal run shows every routing answer: a handled key redrawing through
 * `refresh`, a declined key reaching Hunk's own commands, and Escape handing the
 * keyboard back.
 */
function createInteractiveViewExtension(directory: string) {
  const extension = join(directory, "cursor-mode");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name: "cursor-mode", private: true, hunk: { extensions: ["./index.ts"] } }),
    "utf8",
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  let cursor = 0;
  hunk.registerFileView({
    id: "cursor",
    title: "Cursor demo",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "cursor", spans: [{ text: "CURSOR AT " + cursor }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onKey: (key, ctx) => {
        if (key.name === "j") {
          cursor += 1;
          ctx.fileViews.refresh("cursor");
          return "handled";
        }
        if (key.name === "x") return "exit";
        return "pass";
      },
    },
  });
  hunk.registerCommand({ id: "toggle", title: "Toggle cursor demo", key: "f8" }, (ctx) =>
    ctx.fileViews.toggle("cursor"),
  );
  hunk.registerCommand({ id: "enter", title: "Enter cursor mode", key: "f9" }, (ctx) =>
    ctx.fileViews.enterMode("cursor"),
  );
}
`,
    "utf8",
  );
  return extension;
}

/** Poll one file until the host's write lands, so the assertion is not a race. */
async function waitForWrittenFile(path: string, expected: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let text = readFileSync(path, "utf8");
  while (text !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = readFileSync(path, "utf8");
  }
  return text;
}

describe("PTY file views", () => {
  test("does not load the Markdown example unless the user installs it", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", "--files", pair.before, pair.after],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await session.click(/View/);
      const menu = await session.waitForText(/File presentation: Raw diff/);
      expect(menu).not.toContain("File presentation: Rendered Markdown");
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });

  test("loads the Markdown example and keeps hunk navigation live", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        RENDERED_MARKDOWN_EXTENSION,
        "--mode",
        "stack",
        "--files",
        pair.before,
        pair.after,
      ],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await session.click(/View/);
      const menu = await session.waitForText(/File presentation: Rendered Markdown/, {
        timeout: 20_000,
      });
      expect(menu).toContain("File presentation: Raw diff");

      await session.press("escape");
      await session.press("f8");
      await session.waitForText(/• new item/);
      await session.click(/View/);
      const toggled = await session.waitForText(/\[x\] File presentation: Rendered Markdown/, {
        timeout: 20_000,
      });
      expect(toggled).not.toContain("# Heading");

      await session.press("escape");
      await session.press("]");
      await session.waitIdle();
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });

  for (const demo of [
    {
      name: "change atlas",
      before: join(JSX_FILE_VIEW_GALLERY, "fixtures/change-atlas/before.ts"),
      after: join(JSX_FILE_VIEW_GALLERY, "fixtures/change-atlas/after.ts"),
      view: /File presentation: JSX demo: Change atlas/,
      first: /▶ CHANGE 01/,
      second: /▶ CHANGE 02/,
      raw: /const percent = Math\.min/,
    },
    {
      name: "CSS palette delta",
      before: join(JSX_FILE_VIEW_GALLERY, "fixtures/css-palette/before.css"),
      after: join(JSX_FILE_VIEW_GALLERY, "fixtures/css-palette/after.css"),
      view: /File presentation: JSX demo: CSS palette delta/,
      first: /▶ --accent/,
      second: /▶ --card-highlight/,
      raw: /--canvas: #090d18/,
    },
    {
      name: "dependency delta",
      before: join(JSX_FILE_VIEW_GALLERY, "fixtures/package-dependencies/before/package.json"),
      after: join(JSX_FILE_VIEW_GALLERY, "fixtures/package-dependencies/after/package.json"),
      view: /File presentation: JSX demo: Dependency delta/,
      first: /▶ Package metadata hunk 1/,
      second: /▶\s+@opentui\/core/,
      raw: /"@opentui\/core": "0\.4\.3"/,
    },
  ]) {
    test(`runs the checked-in JSX ${demo.name} against a real diff`, async () => {
      const session = await harness.launchHunk({
        args: [
          "diff",
          "--extension",
          JSX_FILE_VIEW_GALLERY,
          "--mode",
          "stack",
          "--files",
          demo.before,
          demo.after,
        ],
        cwd: JSX_FILE_VIEW_GALLERY,
        cols: 140,
        rows: 24,
      });

      try {
        await session.waitForText(/before\.|package\.json/, { timeout: 20_000 });
        await harness.ensureKeyboardIsLive(session);
        await session.click(/View/);
        await session.waitForText(demo.view, { timeout: 20_000 });
        await session.press("escape");
        await session.press("f8");
        await session.waitForText(demo.first, { timeout: 20_000 });
        await session.press("]");
        await session.waitForText(demo.second, { timeout: 20_000 });
        await session.click(/View/);
        await session.waitForText(/File presentation: Raw diff/, { timeout: 20_000 });
        await session.click(/File presentation: Raw diff/);
        await session.waitForText(demo.raw, { timeout: 20_000 });
      } finally {
        session.close();
      }
    });
  }

  test("retains three preview types between raw diffs in one scrollable review stream", async () => {
    const session = await harness.launchShellCommand({
      command: `${JSON.stringify(process.execPath)} run ${JSON.stringify(JSX_MIXED_REVIEW_LAUNCHER)}`,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/README\.md/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);

      await session.click(/package\.json/, { first: true });
      await session.press("f8");
      await session.waitForText(/Package metadata hunk 1/, { timeout: 20_000 });

      await session.click(/invoice\.ts/, { first: true });
      await session.press("f8");
      await session.waitForText(/CHANGE 01/, { timeout: 20_000 });

      await session.click(/theme\.css/, { first: true });
      await session.press("f8");
      await session.waitForText(/--accent/, { timeout: 20_000 });

      await session.click(/package\.json/, { first: true });
      await session.waitForText(/@opentui\/core/, { timeout: 20_000 });
      await session.click(/README\.md/, { first: true });
      await session.waitForText(/understanding release changes/, { timeout: 20_000 });
      let reachedRetainedPreview = false;
      for (let step = 0; step < 10 && !reachedRetainedPreview; step += 1) {
        await session.scrollDown(8);
        try {
          await session.waitForText(/Package metadata hunk 1/, { timeout: 750 });
          reachedRetainedPreview = true;
        } catch {
          // Continue through the intentionally tall raw README until the retained preview appears.
        }
      }
      expect(reachedRetainedPreview).toBe(true);

      await session.press("q");
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      session.close();
    }
  });

  test("runs the real folder TSX view by key and menu across two hunks", async () => {
    const pair = harness.createMultiHunkFilePair();
    // A fresh folder root avoids Bun reusing an extension module imported by another live test.
    const extension = join(pair.dir, "jsx-runtime-proof");
    cpSync(JSX_FILE_VIEW_EXTENSION, extension, { recursive: true });
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        extension,
        "--mode",
        "stack",
        "--files",
        pair.before,
        pair.after,
      ],
      cwd: pair.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press("f8");
      let custom = await session.waitForText(/▶ Hunk 1/, { timeout: 20_000 });
      expect(custom).toContain("Hunk 2");
      expect(custom).toContain("row 0 · click for detail");
      expect(custom).not.toContain("invalid span");

      // This proves the example's current cooperative routing, not a host guarantee that custom
      // rows will continue receiving pointer input through every future renderer integration.
      await session.click(/▶ Hunk 1/);
      custom = await session.waitForText(/lines 1–4 · @@ -1,4 \+1,4 @@/);
      expect(custom).not.toContain("row 0 · click for detail");

      await session.press("]");
      const secondHunk = await session.waitForText(/▶ Hunk 2/);
      expect(secondHunk).not.toContain("▶ Hunk 1");

      await session.press("f8");
      const raw = await session.waitForText(/line60 = 6000/);
      expect(raw).not.toContain("Hunk 1");

      await session.click(/Extensions/);
      const menu = await session.waitForText(/Toggle JSX hunk cards \(POC\)/);
      expect(menu).toMatch(/Toggle JSX hunk cards \(POC\)\s+F8/);
      await session.click(/Toggle JSX hunk cards \(POC\)/);
      const menuDispatched = await session.waitForText(/▶ Hunk 2/);
      expect(menuDispatched).toContain("Hunk 1");
    } finally {
      session.close();
    }
  });

  test("routes real keypresses into a file view's interactive mode and back out", async () => {
    const pair = harness.createMultiHunkFilePair();
    const extension = createInteractiveViewExtension(pair.dir);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        extension,
        "--mode",
        "stack",
        "--files",
        pair.before,
        pair.after,
      ],
      cwd: pair.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);

      // One press from raw diff: entering the mode selects the view it takes
      // keys for, so the rows and the keyboard arrive together.
      await session.press("f9");
      await session.waitForText(/CURSOR AT 0/, { timeout: 20_000 });
      await session.waitForText(/cursor-mode:cursor mode — Esc exits/, { timeout: 20_000 });

      // Handled keys reach the extension, and the redraw it asks for is what
      // the terminal actually shows.
      await session.press("j");
      await session.waitForText(/CURSOR AT 1/, { timeout: 20_000 });
      await session.press("j");
      await session.waitForText(/CURSOR AT 2/, { timeout: 20_000 });

      // A declined key reaches Hunk's own commands, and the overlay it opens
      // outranks the mode: its Escape closes the overlay, not the mode.
      await session.press("?");
      await session.waitForText(/Controls help/, { timeout: 20_000 });
      await session.press("escape");
      const stillActive = await session.waitForText(/cursor-mode:cursor mode — Esc exits/, {
        timeout: 20_000,
      });
      expect(stillActive).not.toContain("Controls help");

      await session.press("escape");
      const exited = await session.waitForText(/CURSOR AT 2/, { timeout: 20_000 });
      expect(exited).not.toContain("Esc exits");

      // The command table owns the keyboard again.
      await session.press("f8");
      const raw = await session.waitForText(/line60 = 6000/, { timeout: 20_000 });
      expect(raw).not.toContain("CURSOR AT");
    } finally {
      session.close();
    }
  });

  test("runs the inline edit example from typed keys to a written working-tree file", async () => {
    const repo = harness.createTwoFileRepoFixture();
    const edited = join(repo.dir, "alpha.ts");
    const session = await harness.launchHunk({
      args: ["diff", "--extension", INLINE_EDIT_EXTENSION, "--mode", "stack"],
      cwd: repo.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/alpha\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);

      // One press: `enterMode` selects the view for the file and takes the
      // keyboard together, so the editor opens without a second Ctrl-E.
      await session.press(["ctrl", "e"]);
      // The view shows the new document alone, so the removed old-side line is
      // how the terminal reports that the presentation actually switched.
      await harness.waitForSnapshot(session, (text) => !text.includes("alpha = 1"), 20_000);
      await session.waitForText(/EDITING — Esc exits · ctrl\+s writes/, { timeout: 20_000 });
      await session.waitForText(/inline-edit:inline-edit mode — Esc exits/, { timeout: 20_000 });

      // `z` is Hunk's expand-context key; while the mode runs it is text, and
      // each keystroke reaches the screen only through `fileViews.refresh`.
      await session.press("z");
      await session.press("z");
      await session.press("z");
      const typed = await session.waitForText(/zzzexport const alpha = 2;/, { timeout: 20_000 });
      expect(typed).toContain("MODIFIED");

      // `?` is an explicitly host-owned printable key, so help remains
      // reachable and one Escape closes only the overlay, not the editor.
      await session.press("?");
      await session.waitForText(/Controls help/, { timeout: 20_000 });
      await session.press("escape");
      await session.waitForText(/inline-edit:inline-edit mode — Esc exits/, { timeout: 20_000 });

      // The mode can only request the write; the command handler awaiting the
      // session performs it, and the host asks the user first.
      await session.press(["ctrl", "s"]);
      await session.waitForText(/Write alpha\.ts\?/, { timeout: 20_000 });
      const prompt = await session.waitForText(/ext inline-edit/, { timeout: 20_000 });
      expect(prompt).toContain("replace this file's contents on disk");
      await session.press("enter");

      expect(
        await waitForWrittenFile(edited, "zzzexport const alpha = 2;\nexport const add = true;\n"),
      ).toBe("zzzexport const alpha = 2;\nexport const add = true;\n");

      // A successful write reloads the review, and the reload exits the mode.
      await session.waitForText(/zzzexport const alpha = 2;/, { timeout: 20_000 });
      await harness.waitForSnapshot(session, (text) => !text.includes("Esc exits"), 20_000);

      // The command table owns the keyboard again: `z` no longer types.
      await session.press("z");
      await session.waitIdle();
      const afterExit = await session.text();
      expect(afterExit).toContain("zzzexport const alpha = 2;");
      expect(afterExit).not.toContain("zzzz");
    } finally {
      session.close();
    }
  });

  test("keeps an annotated joined line visible in the active editor", async () => {
    const repo = harness.createTwoFileRepoFixture();
    const agentContext = join(repo.dir, "agent.json");
    writeFileSync(
      agentContext,
      JSON.stringify({
        version: 1,
        files: [
          {
            path: "alpha.ts",
            annotations: [{ newRange: [2, 2], summary: "Keep this note visible." }],
          },
        ],
      }),
      "utf8",
    );
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        INLINE_EDIT_EXTENSION,
        "--mode",
        "stack",
        "--agent-context",
        agentContext,
        "--agent-notes",
      ],
      cwd: repo.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/Keep this note visible\./, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press(["ctrl", "e"]);
      await session.waitForText(/EDITING — Esc exits/, { timeout: 20_000 });

      await session.press("down");
      await session.press("backspace");
      const joined = await session.waitForText(/export const alpha = 2;export const add = true;/, {
        timeout: 20_000,
      });
      expect(joined).toContain("EDITING — Esc exits");
      expect(joined).toContain("Keep this note visible.");

      await session.press("z");
      await session.waitForText(/export const alpha = 2;zexport const add = true;/, {
        timeout: 20_000,
      });
      await session.press("escape");
    } finally {
      session.close();
    }
  });

  test("deletes and writes a whole emoji without surrogate corruption", async () => {
    const repo = harness.createTwoFileRepoFixture();
    const edited = join(repo.dir, "alpha.ts");
    writeFileSync(edited, "😀\n", "utf8");
    const session = await harness.launchHunk({
      args: ["diff", "--extension", INLINE_EDIT_EXTENSION, "--mode", "stack"],
      cwd: repo.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/😀/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press(["ctrl", "e"]);
      await session.waitForText(/EDITING — Esc exits/, { timeout: 20_000 });
      await session.press("right");
      await session.press("backspace");
      await session.press(["ctrl", "s"]);
      await session.waitForText(/Write alpha\.ts\?/, { timeout: 20_000 });
      await session.press("enter");

      expect(await waitForWrittenFile(edited, "\n")).toBe("\n");
    } finally {
      session.close();
    }
  });

  test("renders a host-owned inline note inside its bound Markdown presentation", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        RENDERED_MARKDOWN_EXTENSION,
        "--mode",
        "stack",
        "--agent-context",
        pair.agentContext,
        "--agent-notes",
        "--files",
        pair.before,
        pair.after,
      ],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press("f8");
      const preview = await session.waitForText(/• new item/);
      expect(preview).toContain("Review the new item.");
      expect(preview).not.toContain("old item");
      await session.click(/View/);
      const menu = await session.waitForText(/\[x\] File presentation: Rendered Markdown/);
      expect(menu).toContain("File presentation: Raw diff");
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });

  test("falls back all-or-raw for an unbound note and restores the stored view when hidden", async () => {
    const pair = createMarkdownPairTest([99, 99]);
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        RENDERED_MARKDOWN_EXTENSION,
        "--mode",
        "stack",
        "--agent-context",
        pair.agentContext,
        "--agent-notes",
        "--files",
        pair.before,
        pair.after,
      ],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press("f8");
      const raw = await session.waitForText(/old item/);
      expect(raw).not.toContain("• new item");
      await session.click(/View/);
      await session.waitForText(/\[x\] File presentation: Rendered Markdown/);
      await session.press("escape");

      await session.press("a");
      const restored = await session.waitForText(/• new item/);
      expect(restored).not.toContain("old item");
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });
});
