import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, createTestSourceFetcher } from "../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

const JSX_FILE_VIEW_EXTENSION = join(import.meta.dir, "../../examples/extensions/jsx-file-view");
const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy the real folder extension to a fresh import root so Bun cannot reuse another test's module. */
function copyJsxFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-jsx-view-"));
  tempDirs.push(root);
  const extension = join(root, "jsx-runtime-proof");
  cpSync(JSX_FILE_VIEW_EXTENSION, extension, { recursive: true });
  return { extension, root };
}

/** Write a real folder extension whose custom painter fails synchronously. */
function createBrokenFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-broken-view-"));
  tempDirs.push(root);
  const extension = join(root, "broken-row");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name: "broken-row", private: true, hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  hunk.registerFileView({
    id: "broken",
    title: "Broken row",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{
        id: "broken-row",
        spans: [{ text: "SAFE ROW FALLBACK" }],
        component: { height: 1, render: () => { throw new Error("paint exploded"); } },
      }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
  });
  hunk.registerCommand(
    { id: "toggle-broken", title: "Toggle broken row", key: "f8" },
    (ctx) => ctx.fileViews.toggle("broken"),
  );
}
`,
  );
  return { extension, root };
}

/** Write a matching-files preview used to prove the host-owned bulk View action. */
function createBulkFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-bulk-view-"));
  tempDirs.push(root);
  const extension = join(root, "bulk-view");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name: "bulk-view", private: true, hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  hunk.registerFileView({
    id: "preview",
    title: "Bulk preview",
    matches: (file) => file.path.endsWith(".ts"),
    layout: ({ file }) => ({
      rows: [{ id: "preview", spans: [{ text: "PREVIEW " + file.path }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
  });
  hunk.registerCommand(
    { id: "toggle-preview", title: "Toggle bulk preview", key: "f8" },
    (ctx) => ctx.fileViews.toggle("preview"),
  );
}
`,
  );
  return { extension, root };
}

/** Write a stateful preview whose layout only changes when the extension asks for a refresh. */
function createStatefulFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-stateful-view-"));
  tempDirs.push(root);
  const extension = join(root, "stateful-view");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name: "stateful-view", private: true, hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  let expanded = false;
  let pending = false;
  const marked = new Set();
  hunk.registerFileView({
    id: "stateful",
    title: "Stateful view",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [
        {
          id: "state",
          spans: [
            {
              text:
                (expanded ? "STATE EXPANDED" : "STATE COLLAPSED") +
                (marked.has(file.id) ? " MARKED" : "") +
                (pending ? " PENDING" : ""),
            },
          ],
        },
      ],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
  });
  hunk.registerCommand(
    { id: "toggle-stateful", title: "Toggle stateful view", key: "f8" },
    (ctx) => ctx.fileViews.toggle("stateful"),
  );
  hunk.registerCommand(
    { id: "expand-stateful", title: "Expand stateful view", key: "f9" },
    (ctx) => {
      expanded = !expanded;
      ctx.fileViews.refresh("stateful");
    },
  );
  hunk.registerCommand(
    { id: "mark-stateful", title: "Mark this file", key: "f6" },
    (ctx) => {
      const fileId = ctx.selection.file?.id;
      if (!fileId) return;
      marked.add(fileId);
      ctx.fileViews.refresh("stateful", { fileId });
    },
  );
  hunk.registerCommand(
    { id: "refresh-unknown", title: "Refresh unknown view", key: "f7" },
    (ctx) => ctx.fileViews.refresh("not-a-view"),
  );
  hunk.registerCommand(
    { id: "refresh-unknown-file", title: "Refresh a file the review does not carry", key: "f4" },
    (ctx) => {
      pending = true;
      ctx.fileViews.refresh("stateful", { fileId: "no-such-file" });
    },
  );
  hunk.registerCommand(
    { id: "mark-hidden", title: "Mark the changeset's second file", key: "f3" },
    (ctx) => {
      // A reviewed id the command names directly, so it can target a file the filter hides.
      marked.add("beta");
      ctx.fileViews.refresh("stateful", { fileId: "beta" });
    },
  );
}
`,
  );
  return { extension, root };
}

/** Build the separated changes that exercise public summaries and cross-hunk selection. */
function createTwoHunkFile() {
  const beforeLines = Array.from(
    { length: 80 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[59] = "export const line60 = 6000;";
  return createTestDiffFile({
    after: `${afterLines.join("\n")}\n`,
    before: `${beforeLines.join("\n")}\n`,
    context: 3,
    id: "jsx-runtime-proof",
    path: "runtime-proof.ts",
    sourceFetcher: createTestSourceFetcher(async (side) =>
      side === "old" ? `${beforeLines.join("\n")}\n` : `${afterLines.join("\n")}\n`,
    ),
  });
}

/** Paint frames until live extension layout work reaches the renderer. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
  }
  throw new Error(`Timed out waiting for AppHost frame:\n${setup.captureCharFrame()}`);
}

/** Paint a fixed number of frames and return the last, for asserting that nothing changed. */
async function renderFrames(setup: Awaited<ReturnType<typeof testRender>>, frames: number) {
  for (let attempt = 0; attempt < frames; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
  }
  return setup.captureCharFrame();
}

describe("AppHost file views", () => {
  test("attributes one synchronous row-render warning and keeps the symbolic fallback", async () => {
    const { extension, root } = createBrokenFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);

    const notices: string[] = [];
    const notify = extensions.context.notify;
    extensions.context.notify = (message, type) => {
      notices.push(String(message));
      notify(message, type);
    };
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:broken-row",
      files: [createTwoHunkFile()],
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;

    const originalConsoleError = console.error;
    console.error = () => {};
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("runtime-proof.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("SAFE ROW FALLBACK"));
      await waitForFrame(setup, () => notices.some((notice) => notice.includes("paint exploded")));
      await act(async () => setup.renderOnce());

      expect(notices.filter((notice) => notice.includes("paint exploded"))).toEqual([
        expect.stringContaining(
          'Extension broken-row file view "broken" row "broken-row" failed rendering runtime-proof.ts',
        ),
      ]);
    } finally {
      console.error = originalConsoleError;
      await act(async () => setup.renderer.destroy());
    }
  });

  test("re-lays out a stateful view on view-wide and file-scoped refresh, warning for an unknown view id", async () => {
    const { extension, root } = createStatefulFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:stateful-view",
      files: [createTestDiffFile({ id: "stateful", path: "stateful.ts" })],
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("stateful.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("STATE COLLAPSED"));

      // Neither the file nor the width changed, so only the refresh can re-derive these rows.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("STATE EXPANDED"));

      // The same re-derivation, scoped to the reviewed file whose state the command changed.
      await act(async () => setup.mockInput.pressKey("F6"));
      await waitForFrame(setup, (frame) => frame.includes("STATE EXPANDED MARKED"));

      await act(async () => setup.mockInput.pressKey("F7"));
      const warned = await waitForFrame(setup, (frame) =>
        frame.includes('targeted unknown file view "not-a-view"'),
      );
      // An unknown id refuses without disturbing the presentation the user is looking at.
      expect(warned).toContain("STATE EXPANDED MARKED");

      // A scope naming a file the review does not carry could only invalidate a layout that does
      // not exist, so the host stores no epoch for it and nothing re-lays out.
      await act(async () => setup.mockInput.pressKey("F4"));
      const unchanged = await renderFrames(setup, 12);
      expect(unchanged).toContain("STATE EXPANDED MARKED");
      expect(unchanged).not.toContain("PENDING");

      // The state the ignored refresh left behind is genuinely live: the next real invalidation
      // picks it up, so the frames above were quiet for want of an epoch, not want of a change.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("STATE COLLAPSED MARKED PENDING"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("honors a file-scoped refresh for a file the current filter hides", async () => {
    const { extension, root } = createStatefulFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:hidden-refresh",
      files: [
        createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
        createTestDiffFile({ id: "beta", path: "beta.ts" }),
      ],
      initialMode: "split",
      inputMode: "split",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 220,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      // Put both files on the stateful view so the hidden one has a prepared layout to retire.
      await act(async () => setup.mockInput.pressKey("F8"));
      await act(async () => setup.mockInput.typeText("."));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.split("STATE COLLAPSED").length === 3);

      await act(async () => setup.mockInput.pressTab());
      await waitForFrame(setup, (frame) => frame.toLowerCase().includes("filter"));
      await act(async () => setup.mockInput.typeText("alpha"));
      await waitForFrame(setup, (frame) => !frame.includes("beta.ts"));
      await act(async () => setup.mockInput.pressTab());

      // Filtering hides a file without un-reviewing it, so its scoped epoch must still be recorded.
      await act(async () => setup.mockInput.pressKey("F3"));
      await act(async () => setup.mockInput.pressTab());
      await waitForFrame(setup, (frame) => frame.includes("filter: alpha"));
      await act(async () => setup.mockInput.pressEscape());
      // Both files present the view again once the unhidden one finishes re-preparing.
      const restored = await waitForFrame(
        setup,
        (frame) => frame.split("STATE COLLAPSED").length === 3,
      );
      expect(restored).toContain("STATE COLLAPSED MARKED");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("applies the active presentation changeset-wide, including filter-hidden matches", async () => {
    const { extension, root } = createBulkFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);
    const files = [
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
      createTestDiffFile({ id: "notes", path: "notes.md" }),
    ];
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:bulk-view",
      files,
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => {
        await setup.mockInput.pressTab();
        await setup.mockInput.typeText("alpha");
        await setup.mockInput.pressTab();
        await setup.mockInput.pressKey("F8");
      });
      await waitForFrame(setup, (frame) => frame.includes("PREVIEW alpha.ts"));

      await act(async () => setup.mockInput.pressKey("F10"));
      await waitForFrame(setup, (frame) => frame.includes("Toggle files/filter focus"));
      await act(async () => {
        await setup.mockInput.pressArrow("right");
        // Height-clamped dropdowns window around the active item; wrap to the final action.
        await setup.mockInput.pressArrow("up");
      });
      const menu = await waitForFrame(setup, (frame) =>
        frame.includes("Apply “Bulk preview” to all matching files"),
      );
      const lines = menu.split("\n");
      const targetY = lines.findIndex((line) =>
        line.includes("Apply “Bulk preview” to all matching files"),
      );
      const targetX = lines[targetY]!.indexOf("Apply “Bulk preview”");
      await act(async () => setup.mockMouse.click(targetX, targetY));

      await act(async () => {
        await setup.mockInput.pressTab();
        await setup.mockInput.pressEscape();
        await setup.mockInput.pressTab();
      });
      const expanded = await waitForFrame(
        setup,
        (frame) => frame.includes("PREVIEW alpha.ts") && frame.includes("PREVIEW beta.ts"),
      );
      expect(expanded).not.toContain("PREVIEW notes.md");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("runs the real folder TSX view with row-safe summaries, navigation, and mouse-up state", async () => {
    const { extension, root } = copyJsxFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);

    const notices: string[] = [];
    extensions.notifications.subscribe((notice) => notices.push(notice.message));
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:jsx-runtime-proof",
      files: [createTwoHunkFile()],
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;

    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });
    const copied: string[] = [];
    setup.renderer.isOsc52Supported = () => true;
    setup.renderer.copyToClipboardOSC52 = (text: string) => {
      copied.push(text);
      return true;
    };

    try {
      await waitForFrame(setup, (frame) => frame.includes("runtime-proof.ts"));
      await act(async () => {
        await setup.mockInput.pressKey("F8");
      });
      let frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("Hunk 1") && nextFrame.includes("Hunk 2"),
      );
      expect(frame).toContain("▶ Hunk 1");
      expect(notices.some((notice) => notice.includes("invalid span"))).toBe(false);

      const cardY = frame.split("\n").findIndex((line) => line.includes("▶ Hunk 1"));
      const cardX = frame.split("\n")[cardY]!.indexOf("Hunk 1");
      expect(cardY).toBeGreaterThanOrEqual(0);
      expect(cardX).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup.mockMouse.pressDown(cardX, cardY);
      });
      frame = setup.captureCharFrame();
      expect(frame).toContain("click for detail");

      await act(async () => {
        await setup.mockMouse.release(cardX, cardY);
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("lines 1–4 · @@"));
      expect(frame).not.toContain("row 0 · click for detail");
      expect(copied).toEqual([]);

      await act(async () => {
        await setup.mockInput.typeText("]");
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("▶ Hunk 2"));
      expect(frame).not.toContain("▶ Hunk 1");

      await act(async () => {
        await setup.mockInput.pressKey("F8");
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("line60 = 6000"));
      expect(frame).not.toContain("Hunk 1");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("steps the current line through the rows an alternate presentation renders", async () => {
    const { extension, root } = copyJsxFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);

    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:jsx-runtime-proof",
      files: [createTwoHunkFile()],
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;

    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("runtime-proof.ts"));
      await act(async () => {
        await setup.mockInput.pressKey("F8");
      });
      let frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("▶ Hunk 1"));
      expect(frame).not.toContain("▶ Hunk 2");

      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("▶ Hunk 2"));
      expect(frame).not.toContain("▶ Hunk 1");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
