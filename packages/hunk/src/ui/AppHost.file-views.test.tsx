import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import {
  createTestAgentFileContext,
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";
import {
  documentHighlightRunsForLine,
  loadDocumentHighlight,
} from "./diff/documentHighlightService";
import { resolveTheme } from "./themes";
import { setFileViewSyntaxHighlightLoaderForTest } from "./fileViews/useFileViewSyntaxHighlight";
import type {
  DocumentHighlightInput,
  DocumentHighlightResult,
} from "./diff/documentHighlightService";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";

const JSX_FILE_VIEW_EXTENSION = join(
  import.meta.dir,
  "../../../../examples/extensions/jsx-file-view",
);
const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  setFileViewSyntaxHighlightLoaderForTest();
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
    JSON.stringify({
      name: "broken-row",
      private: true,
      hunk: { extensions: ["./index.ts"] },
    }),
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

/** Return the complete generated document used by the deterministic syntax integration view. */
function phase9SyntaxLines() {
  return Array.from({ length: 80 }, (_, index) =>
    index === 8
      ? "/* multiline comment"
      : index === 9
        ? "still commented */"
        : index === 20
          ? "const template = `value ${21}`;"
          : `const phase9Line${index + 1} = ${index + 1};`,
  );
}

/** Write a syntax-enabled preview whose layout count remains observable across paint-only updates. */
function createSyntaxFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-syntax-view-"));
  tempDirs.push(root);
  const extension = join(root, "syntax-view");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "syntax-view",
      private: true,
      hunk: { extensions: ["./index.ts"] },
    }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  globalThis.__hunkPhase9SyntaxLayouts = 0;
  const lines = ${JSON.stringify(phase9SyntaxLines())};
  hunk.registerFileView({
    id: "syntax",
    title: "Syntax preview",
    matches: () => true,
    layout: ({ file }) => {
      globalThis.__hunkPhase9SyntaxLayouts += 1;
      return {
        codeDocuments: [{ id: "source", text: lines.join("\\n"), language: "typescript" }],
        rows: lines.map((text, index) => ({
          id: "syntax-" + index,
          spans: [{ text, syntax: { documentId: "source", line: index + 1 } }],
          ...(index === 0 ? { sourceRanges: [{ side: "new", range: [1, 1] }] } : {}),
        })),
        hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: lines.length - 1 })),
      };
    },
  });
  hunk.registerCommand({ id: "toggle-syntax", title: "Toggle syntax", key: "f8" }, (ctx) =>
    ctx.fileViews.toggle("syntax"),
  );
}
`,
  );
  return { extension, root };
}

/** Write a compact per-file syntax view for deterministic cross-file stale-result tests. */
function createSyntaxFileRaceExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-syntax-file-race-"));
  tempDirs.push(root);
  const extension = join(root, "syntax-file-race");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "syntax-file-race",
      private: true,
      hunk: { extensions: ["./index.ts"] },
    }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  hunk.registerFileView({
    id: "syntax-race",
    title: "Syntax race",
    matches: () => true,
    layout: ({ file }) => {
      const name = file.path.startsWith("alpha") ? "alphaSyntax" : "betaSyntax";
      const text = "const " + name + " = 1;";
      return {
        codeDocuments: [{ id: "source", text, language: "typescript" }],
        rows: [{
          id: "syntax-race",
          spans: [{ text, syntax: { documentId: "source", line: 1 } }],
        }],
        hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    },
  });
  hunk.registerCommand({ id: "toggle-syntax-race", title: "Toggle syntax race", key: "f8" },
    (ctx) => ctx.fileViews.toggle("syntax-race"));
}
`,
  );
  return { extension, root };
}

/** Return the first captured foreground for a terminal span containing the requested text. */
function capturedForeground(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  return capturedTestColorToHex(span?.fg)?.toLowerCase();
}

/** Write a matching-files preview used to prove the host-owned bulk View action. */
function createBulkFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-bulk-view-"));
  tempDirs.push(root);
  const extension = join(root, "bulk-view");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({
      name: "bulk-view",
      private: true,
      hunk: { extensions: ["./index.ts"] },
    }),
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
    JSON.stringify({
      name: "stateful-view",
      private: true,
      hunk: { extensions: ["./index.ts"] },
    }),
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

/** Return the captured terminal row carrying one unique text marker. */
function capturedRowIndex(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  return setup
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(text));
}

/** Paint frames until one deterministic asynchronous test condition becomes true. */
async function waitForCondition(
  setup: Awaited<ReturnType<typeof testRender>>,
  condition: () => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(10);
    });
    if (condition()) return;
  }
  throw new Error(`Timed out waiting for AppHost condition:\n${setup.captureCharFrame()}`);
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
  test("rejects stale syntax paint while keeping the accepted layout mounted", async () => {
    const { extension, root } = createSyntaxFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    expect(extensions.issues).toEqual([]);

    const documentText = phase9SyntaxLines().join("\n");
    const [darkResult, dimmedResult] = await Promise.all(
      (["github-dark-default", "github-dark-dimmed"] as const).map((themeId) =>
        loadDocumentHighlight({
          text: documentText,
          path: "syntax-apphost.ts",
          language: "typescript",
          theme: resolveTheme(themeId, null),
          offloadLargeDiff: false,
        }),
      ),
    );
    const expectedDark = documentHighlightRunsForLine(darkResult, 0).find(
      (run) => run.start === 0 && run.fg,
    )?.fg;
    const expectedDimmed = documentHighlightRunsForLine(dimmedResult, 0).find(
      (run) => run.start === 0 && run.fg,
    )?.fg;
    expect(expectedDark).toBeDefined();
    expect(expectedDimmed).toBeDefined();
    expect(expectedDimmed).not.toBe(expectedDark);

    const pending: Array<{
      input: DocumentHighlightInput;
      deferred: ReturnType<typeof createTestDeferred<DocumentHighlightResult>>;
    }> = [];
    setFileViewSyntaxHighlightLoaderForTest((input) => {
      const deferred = createTestDeferred<DocumentHighlightResult>();
      pending.push({ input, deferred });
      return deferred.promise;
    });

    const after = "const after = 2;\n";
    const sourceFetcher = createTestSourceFetcher(async () => after);
    const file = createTestDiffFile({
      id: "syntax-apphost",
      path: "syntax-apphost.ts",
      before: "const before = 1;\n",
      after,
      agent: createTestAgentFileContext("syntax-apphost.ts", {
        annotations: [{ newRange: [1, 1], summary: "Pinned syntax note" }],
      }),
      sourceFetcher,
    });
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:syntax-apphost",
      files: [file],
      initialMode: "unified",
      inputMode: "unified",
      initialShowAgentNotes: true,
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });
    const metrics = globalThis as typeof globalThis & {
      __hunkPhase9SyntaxLayouts?: number;
    };

    try {
      await waitForFrame(setup, (frame) => frame.includes("syntax-apphost.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("const phase9Line1 = 1;"));
      await waitForCondition(setup, () => pending.length === 1);

      // The symbolic view, exact row order, bound note, and geometry are present before paint arrives.
      const pendingRows = {
        code1: capturedRowIndex(setup, "const phase9Line1 = 1;"),
        code2: capturedRowIndex(setup, "const phase9Line2 = 2;"),
        note: capturedRowIndex(setup, "Pinned syntax note"),
      };
      expect(Object.values(pendingRows).every((row) => row >= 0)).toBe(true);
      expect(setup.captureCharFrame()).not.toContain("const after = 2;");
      expect(metrics.__hunkPhase9SyntaxLayouts).toBe(1);
      expect(sourceFetcher.calls).toEqual(["new"]);

      await act(async () => setup.mockInput.typeText("t"));
      await waitForFrame(setup, (frame) => frame.includes("Theme selector"));
      await act(async () => {
        await setup.mockInput.pressArrow("down");
        await setup.mockInput.pressEnter();
      });
      await waitForFrame(setup, (frame) => frame.includes("Theme: github-dark-dimmed"));
      await waitForCondition(setup, () => pending.length === 2);

      await act(async () => pending[0]!.deferred.resolve(darkResult!));
      await renderFrames(setup, 4);
      expect(capturedForeground(setup, "const")).not.toBe(expectedDark?.toLowerCase());
      expect(capturedForeground(setup, "const")).not.toBe(expectedDimmed?.toLowerCase());

      await act(async () => pending[1]!.deferred.resolve(dimmedResult!));
      await waitForCondition(
        setup,
        () => capturedForeground(setup, "const") === expectedDimmed?.toLowerCase(),
      );
      expect(capturedForeground(setup, "const")).toBe(expectedDimmed?.toLowerCase());
      expect(capturedForeground(setup, "const")).not.toBe(expectedDark?.toLowerCase());
      expect({
        code1: capturedRowIndex(setup, "const phase9Line1 = 1;"),
        code2: capturedRowIndex(setup, "const phase9Line2 = 2;"),
        note: capturedRowIndex(setup, "Pinned syntax note"),
      }).toEqual(pendingRows);
      expect(metrics.__hunkPhase9SyntaxLayouts).toBe(1);
      expect(sourceFetcher.calls).toEqual(["new"]);
    } finally {
      delete metrics.__hunkPhase9SyntaxLayouts;
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keeps permanent and exhausted retryable syntax fallback inside the FileView", async () => {
    const { extension, root } = createSyntaxFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    const calls: DocumentHighlightInput[] = [];
    setFileViewSyntaxHighlightLoaderForTest(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? Object.freeze({
            status: "fallback",
            reason: "unsupported-language",
            retryable: false,
          })
        : Object.freeze({
            status: "fallback",
            reason: "busy",
            retryable: true,
          });
    });
    const after = "const after = 2;\n";
    const sourceFetcher = createTestSourceFetcher(async () => after);
    const file = createTestDiffFile({
      id: "syntax-fallback",
      path: "syntax-fallback.ts",
      before: "const before = 1;\n",
      after,
      sourceFetcher,
    });
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:syntax-fallback",
      files: [file],
      initialMode: "unified",
      inputMode: "unified",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });
    const metrics = globalThis as typeof globalThis & {
      __hunkPhase9SyntaxLayouts?: number;
    };

    try {
      await waitForFrame(setup, (frame) => frame.includes("syntax-fallback.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("const phase9Line1 = 1;"));
      await waitForCondition(setup, () => calls.length === 1);
      const permanentRows = [
        capturedRowIndex(setup, "const phase9Line1 = 1;"),
        capturedRowIndex(setup, "const phase9Line2 = 2;"),
      ];

      await act(async () => setup.mockInput.typeText("t"));
      await waitForFrame(setup, (frame) => frame.includes("Theme selector"));
      await act(async () => {
        await setup.mockInput.pressArrow("down");
        await setup.mockInput.pressEnter();
      });
      await waitForCondition(setup, () => calls.length === 3);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("const phase9Line1 = 1;");
      expect(frame).not.toContain("const after = 2;");
      expect([
        capturedRowIndex(setup, "const phase9Line1 = 1;"),
        capturedRowIndex(setup, "const phase9Line2 = 2;"),
      ]).toEqual(permanentRows);
      expect(metrics.__hunkPhase9SyntaxLayouts).toBe(1);
      expect(sourceFetcher.calls).toEqual(["new"]);
      await renderFrames(setup, 8);
      expect(calls).toHaveLength(3);
    } finally {
      delete metrics.__hunkPhase9SyntaxLayouts;
      await act(async () => setup.renderer.destroy());
    }
  });

  test("never projects a late file-A syntax result into file B", async () => {
    const { extension, root } = createSyntaxFileRaceExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    const [alphaResult, betaResult] = await Promise.all([
      loadDocumentHighlight({
        text: "const alphaSyntax = 1;",
        path: "alpha.ts",
        language: "typescript",
        theme: resolveTheme("github-dark-default", null),
        offloadLargeDiff: false,
      }),
      loadDocumentHighlight({
        text: "const betaSyntax = 1;",
        path: "beta.ts",
        language: "typescript",
        theme: resolveTheme("github-dark-dimmed", null),
        offloadLargeDiff: false,
      }),
    ]);
    const alphaColor = documentHighlightRunsForLine(alphaResult, 0)
      .find((run) => run.start === 5)
      ?.fg?.toLowerCase();
    const betaColor = documentHighlightRunsForLine(betaResult, 0)
      .find((run) => run.start === 5)
      ?.fg?.toLowerCase();
    expect(alphaColor).toBeDefined();
    expect(betaColor).toBeDefined();
    expect(betaColor).not.toBe(alphaColor);

    const pending: Array<{
      input: DocumentHighlightInput;
      deferred: ReturnType<typeof createTestDeferred<DocumentHighlightResult>>;
    }> = [];
    setFileViewSyntaxHighlightLoaderForTest((input) => {
      const deferred = createTestDeferred<DocumentHighlightResult>();
      pending.push({ input, deferred });
      return deferred.promise;
    });
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:syntax-file-race",
      files: [
        createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
        createTestDiffFile({ id: "beta", path: "beta.ts" }),
      ],
      initialMode: "unified",
      inputMode: "unified",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 160,
      height: 30,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("const alphaSyntax = 1;"));
      await waitForCondition(setup, () => pending.some(({ input }) => input.path === "alpha.ts"));

      await act(async () => setup.mockInput.typeText("."));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("const betaSyntax = 1;"));
      await waitForCondition(setup, () => pending.some(({ input }) => input.path === "beta.ts"));
      const alphaPending = pending.find(({ input }) => input.path === "alpha.ts")!;
      const betaPending = pending.find(({ input }) => input.path === "beta.ts")!;

      await act(async () => alphaPending.deferred.resolve(alphaResult));
      await renderFrames(setup, 4);
      expect(capturedForeground(setup, "alphaSyntax")).toBe(alphaColor);
      expect(capturedForeground(setup, "betaSyntax")).not.toBe(alphaColor);
      expect(capturedForeground(setup, "betaSyntax")).not.toBe(betaColor);

      await act(async () => betaPending.deferred.resolve(betaResult));
      await waitForCondition(setup, () => capturedForeground(setup, "betaSyntax") === betaColor);
      expect(capturedForeground(setup, "betaSyntax")).toBe(betaColor);
      expect(setup.captureCharFrame()).toContain("const alphaSyntax = 1;");
      expect(setup.captureCharFrame()).toContain("const betaSyntax = 1;");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("attributes one synchronous row-render warning and keeps the symbolic fallback", async () => {
    const { extension, root } = createBrokenFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
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
      initialMode: "unified",
      inputMode: "unified",
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
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    expect(extensions.issues).toEqual([]);
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:stateful-view",
      files: [createTestDiffFile({ id: "stateful", path: "stateful.ts" })],
      initialMode: "unified",
      inputMode: "unified",
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
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
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
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
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
      initialMode: "unified",
      inputMode: "unified",
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
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    expect(extensions.issues).toEqual([]);

    const notices: string[] = [];
    extensions.notifications.subscribe((notice) => notices.push(notice.message));
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:jsx-runtime-proof",
      files: [createTwoHunkFile()],
      initialMode: "unified",
      inputMode: "unified",
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
      extensions: {
        enabled: true,
        extensionConfigs: {},
        paths: [],
        repoPaths: [],
      },
    });
    expect(extensions.issues).toEqual([]);

    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:jsx-runtime-proof",
      files: [createTwoHunkFile()],
      initialMode: "unified",
      inputMode: "unified",
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
