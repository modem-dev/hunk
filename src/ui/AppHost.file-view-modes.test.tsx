import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Write one folder extension whose factory source is given verbatim. */
function createModeExtension(name: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), `hunk-apphost-${name}-`));
  tempDirs.push(root);
  const extension = join(root, name);
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name, private: true, hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(join(extension, "index.ts"), source);
  return { extension, root };
}

/**
 * A view whose mode moves a cursor, declines some keys, and exits on its own.
 *
 * `j` and `n` are answered (`j` also refreshes, so the routed key is visible on
 * screen), `x` leaves, and everything else is declined — which is what lets the
 * bound `p` command and the host's own navigation keep working while the mode
 * holds the keyboard.
 */
function createInteractiveModeExtension() {
  return createModeExtension(
    "interactive-view",
    `export default function (hunk) {
  let cursor = 0;
  hunk.registerFileView({
    id: "outline",
    title: "Outline",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "cursor", spans: [{ text: "CURSOR " + cursor }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onEnter: (ctx) => ctx.notify("MODE ENTER " + ctx.file.path),
      onExit: (ctx) => ctx.notify("MODE EXIT " + ctx.file.path),
      onKey: (key, ctx) => {
        ctx.notify("MODE KEY " + key.name);
        if (key.name === "j") {
          cursor += 1;
          ctx.fileViews.refresh("outline");
          return "handled";
        }
        if (key.name === "n") return "handled";
        if (key.name === "x") return "exit";
        return "pass";
      },
    },
  });
  hunk.registerFileView({
    id: "plain",
    title: "Plain",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "plain", spans: [{ text: "PLAIN VIEW" }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
  });
  hunk.registerCommand({ id: "toggle", title: "Toggle outline", key: "f8" }, (ctx) =>
    ctx.fileViews.toggle("outline"),
  );
  hunk.registerCommand({ id: "enter", title: "Enter outline mode", key: "f9" }, (ctx) => {
    ctx.notify("ENTER RESULT " + ctx.fileViews.enterMode("outline"));
    ctx.notify("MODE ACTIVE " + ctx.fileViews.isModeActive("outline"));
  });
  hunk.registerCommand({ id: "enter-plain", title: "Enter plain mode", key: "f7" }, (ctx) => {
    ctx.notify("PLAIN RESULT " + ctx.fileViews.enterMode("plain"));
  });
  hunk.registerCommand({ id: "enter-missing", title: "Enter unknown mode", key: "f6" }, (ctx) => {
    ctx.notify("MISSING RESULT " + ctx.fileViews.enterMode("not-a-view"));
  });
  hunk.registerCommand({ id: "leave", title: "Leave the mode", key: "f5" }, (ctx) => {
    ctx.fileViews.exitMode();
    ctx.fileViews.exitMode();
  });
  hunk.registerCommand({ id: "answered", title: "Answered command", key: "n" }, (ctx) =>
    ctx.notify("COMMAND N RAN"),
  );
  hunk.registerCommand({ id: "declined", title: "Declined command", key: "p" }, (ctx) =>
    ctx.notify("COMMAND P RAN"),
  );
}
`,
  );
}

/** A mode whose key handler throws, to prove the host contains it. */
function createBrokenModeExtension() {
  return createModeExtension(
    "broken-mode",
    `export default function (hunk) {
  hunk.registerFileView({
    id: "boom",
    title: "Boom",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "boom", spans: [{ text: "BOOM VIEW" }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onExit: (ctx) => ctx.notify("BOOM EXIT " + ctx.file.path),
      onKey: () => {
        throw new Error("key handler exploded");
      },
    },
  });
  hunk.registerCommand({ id: "toggle", title: "Toggle boom", key: "f8" }, (ctx) =>
    ctx.fileViews.toggle("boom"),
  );
  hunk.registerCommand({ id: "enter", title: "Enter boom mode", key: "f9" }, (ctx) =>
    ctx.fileViews.enterMode("boom"),
  );
  hunk.registerCommand({ id: "declined", title: "Declined command", key: "p" }, (ctx) =>
    ctx.notify("COMMAND P RAN"),
  );
}
`,
  );
}

/** Boot AppHost against one folder extension and capture its notifications. */
async function renderWithExtension(
  { extension, root }: { extension: string; root: string },
  files = [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
) {
  const extensions = await loadStartupExtensions({
    cliExtensionPaths: [extension],
    cwd: root,
    env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
    extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
  });
  expect(extensions.issues).toEqual([]);
  // Wrap the shared sink rather than subscribing: the hub keeps one listener,
  // and App claims it as soon as it mounts its toast surface.
  const notices: string[] = [];
  const notify = extensions.context.notify;
  extensions.context.notify = (message, type) => {
    notices.push(String(message));
    notify(message, type);
  };
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "changeset:file-view-mode",
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
  return { notices, setup };
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

/** Wait for a notification an extension raised, failing with what did arrive. */
async function waitForNotice(
  setup: Awaited<ReturnType<typeof testRender>>,
  notices: readonly string[],
  match: string,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (notices.some((notice) => notice.includes(match))) return;
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
  }
  throw new Error(`Timed out waiting for "${match}". Notices:\n${notices.join("\n")}`);
}

describe("AppHost file-view modes", () => {
  test("routes keys to an active mode and hands the keyboard back on Escape", async () => {
    const { notices, setup } = await renderWithExtension(createInteractiveModeExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR 0"));

      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT true");
      expect(notices).toContain("MODE ENTER alpha.ts");
      expect(notices).toContain("MODE ACTIVE true");
      // The one visible sign the extension is holding the keyboard.
      await waitForFrame(setup, (frame) =>
        frame.includes("interactive-view:outline mode — Esc exits"),
      );

      // "handled": the mode acted, and the redraw it asked for is on screen.
      await act(async () => setup.mockInput.typeText("j"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR 1"));

      // "handled" for a key the command table binds: the command must not run.
      await act(async () => setup.mockInput.typeText("n"));
      await act(async () => setup.renderOnce());
      expect(notices).not.toContain("COMMAND N RAN");

      // "pass": the command bound to the key still fires, exactly as it would
      // with no mode running.
      await act(async () => setup.mockInput.typeText("p"));
      await waitForNotice(setup, notices, "COMMAND P RAN");

      // Escape is host-owned: it exits without ever reaching onKey, which
      // announces every key it is handed.
      expect(notices).toContain("MODE KEY j");
      await act(async () => setup.mockInput.pressEscape());
      await waitForNotice(setup, notices, "MODE EXIT alpha.ts");
      await waitForFrame(setup, (frame) => !frame.includes("mode — Esc exits"));
      expect(notices).not.toContain("MODE KEY escape");

      // With the mode gone, the previously answered key reaches its command.
      await act(async () => setup.mockInput.typeText("n"));
      await waitForNotice(setup, notices, "COMMAND N RAN");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("leaves the mode when the handler exits, the view is deselected, or the file changes", async () => {
    const { notices, setup } = await renderWithExtension(createInteractiveModeExtension(), [
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
    ]);

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR 0"));

      // "exit": the key is consumed and the mode ends.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "MODE ENTER alpha.ts");
      await act(async () => setup.mockInput.typeText("x"));
      await waitForNotice(setup, notices, "MODE EXIT alpha.ts");

      // exitMode() is idempotent: a second call runs no second teardown.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT true");
      await act(async () => setup.mockInput.pressKey("F5"));
      await waitForFrame(setup, () => !setup.captureCharFrame().includes("mode — Esc exits"));
      expect(notices.filter((notice) => notice === "MODE EXIT alpha.ts")).toHaveLength(2);

      // Toggling the presentation away takes the mode with it: the mode's keys
      // belong to rows that are no longer on screen.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT true");
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => !frame.includes("CURSOR"));
      expect(notices.filter((notice) => notice === "MODE EXIT alpha.ts")).toHaveLength(3);

      // And so does moving to another file, through a key the mode declined —
      // the pass reaches the command table, which navigates the review away.
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT true");
      await act(async () => setup.mockInput.typeText("."));
      await waitForFrame(setup, () => notices.filter((n) => n === "MODE EXIT alpha.ts").length > 3);
      expect(setup.captureCharFrame()).not.toContain("mode — Esc exits");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("refuses to enter an unknown view, a view with no mode, or an inactive view", async () => {
    const { notices, setup } = await renderWithExtension(createInteractiveModeExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));

      // The view exists and has a mode, but the file is still on raw diff.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT false");
      await waitForFrame(setup, (frame) =>
        frame.includes('File view "outline" is not the selected file\'s presentation'),
      );
      expect(notices).toContain("MODE ACTIVE false");
      expect(notices).not.toContain("MODE ENTER alpha.ts");

      await act(async () => setup.mockInput.pressKey("F6"));
      await waitForNotice(setup, notices, "MISSING RESULT false");
      await waitForFrame(setup, (frame) =>
        frame.includes('targeted unknown file view "not-a-view"'),
      );

      // A registered view that never declared a mode refuses by name.
      await act(async () => setup.mockInput.pressKey("F7"));
      await waitForNotice(setup, notices, "PLAIN RESULT false");
      await waitForFrame(setup, (frame) =>
        frame.includes('file view "plain" has no interactive mode'),
      );
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("contains a throwing key handler by warning, exiting, and keeping the review usable", async () => {
    const { notices, setup } = await renderWithExtension(createBrokenModeExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("BOOM VIEW"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("mode — Esc exits"));

      await act(async () => setup.mockInput.typeText("j"));
      await waitForNotice(setup, notices, "key handler exploded");
      expect(notices).toContain(
        'Extension broken-mode file view "boom" mode failed onKey • key handler exploded',
      );
      // The throw ends the mode rather than leaving it holding every later key.
      expect(notices).toContain("BOOM EXIT alpha.ts");
      await waitForFrame(setup, (frame) => !frame.includes("mode — Esc exits"));

      await act(async () => setup.mockInput.typeText("p"));
      await waitForNotice(setup, notices, "COMMAND P RAN");
      expect(setup.captureCharFrame()).toContain("BOOM VIEW");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
