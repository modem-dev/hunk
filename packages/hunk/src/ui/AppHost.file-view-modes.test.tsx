import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { KeyEvent, type ParsedKey } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import { createWatchTestRuntime } from "../../../../test/helpers/watchTest";
import { loadAppBootstrap } from "../core/changeset/loaders";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build one key event to publish directly to the renderer's key handler.
 *
 * Only the multi-key-in-one-flush case needs this: `mockInput` writes bytes and
 * lets each parsed key settle, so it can never put two keys in front of the
 * routing chain without a render between them.
 */
function testKeyEvent(fields: Partial<ParsedKey>): KeyEvent {
  return new KeyEvent({
    name: "",
    sequence: "",
    raw: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    number: false,
    eventType: "press",
    source: "raw",
    ...fields,
  });
}

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
  // A view with a mode that claims no file at all: entering can never make its
  // rows visible, so it is the refusal a selection cannot fix.
  hunk.registerFileView({
    id: "picky",
    title: "Picky",
    matches: () => false,
    layout: () => null,
    mode: { onKey: () => "handled" },
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
  hunk.registerCommand({ id: "enter-picky", title: "Enter picky mode", key: "f4" }, (ctx) => {
    ctx.notify("PICKY RESULT " + ctx.fileViews.enterMode("picky"));
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

/**
 * Two views that both declare modes, plus a command bound to Escape.
 *
 * The pair is what "one session runs one mode" is checked against: entering the
 * second while the first holds the keyboard must tear the first down. The
 * Escape binding is the observable for the other question — whether a second
 * Escape arriving in the same input flush, after the first already exited the
 * mode, is still swallowed as if the mode were running.
 */
function createModeHandoffExtension() {
  return createModeExtension(
    "mode-handoff",
    `export default function (hunk) {
  const view = (id) => ({
    id,
    title: id,
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id, spans: [{ text: id.toUpperCase() + " VIEW" }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onEnter: (ctx) => ctx.notify("ENTER " + id),
      onExit: (ctx) => ctx.notify("EXIT " + id),
      onKey: (key, ctx) => {
        ctx.notify("KEY " + id + " " + key.name);
        if (key.name === "r") {
          ctx.fileViews.enterMode("beta");
          return "exit";
        }
        if (key.name === "x") return "exit";
        return key.name === "n" ? "handled" : "pass";
      },
    },
  });
  hunk.registerFileView(view("alpha"));
  hunk.registerFileView(view("beta"));
  hunk.registerCommand({ id: "enter-alpha", title: "Enter alpha", key: "f9" }, (ctx) =>
    ctx.notify("ALPHA RESULT " + ctx.fileViews.enterMode("alpha")),
  );
  hunk.registerCommand({ id: "enter-beta", title: "Enter beta", key: "f7" }, (ctx) =>
    ctx.notify("BETA RESULT " + ctx.fileViews.enterMode("beta")),
  );
  hunk.registerCommand({ id: "escaped", title: "Escaped", key: "escape" }, (ctx) =>
    ctx.notify("ESCAPE COMMAND RAN"),
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

/**
 * A mode entered only after an awaited dialog settles.
 *
 * The await is the point: a soft reload lands while the handler is parked, and
 * the mode it then enters belongs to the review that reload produced.
 */
function createDeferredModeExtension() {
  return createModeExtension(
    "mode-reload",
    `export default function (hunk) {
  hunk.registerFileView({
    id: "editor",
    title: "Editor",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "editor", spans: [{ text: "EDITOR VIEW" }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onEnter: (ctx) => ctx.notify("MODE ENTER " + ctx.file.path),
      onExit: (ctx) => ctx.notify("MODE EXIT " + ctx.file.path),
      onKey: () => "handled",
    },
  });
  hunk.registerCommand({ id: "ask-then-enter", title: "Ask then enter", key: "f9" }, async (ctx) => {
    const answered = await ctx.dialogs.confirm({ title: "Ready to edit?" });
    ctx.notify("DIALOG ANSWER " + answered);
    ctx.notify("LATE RESULT " + ctx.fileViews.enterMode("editor"));
  });
}
`,
  );
}

/**
 * Boot AppHost over a real file-pair review whose reloads the test drives.
 *
 * A watched input is the seam: the injected runtime turns "the source changed"
 * into the same soft reload the refresh key takes, without the test needing a
 * daemon or a keypress that a modal surface would swallow.
 */
async function renderWatchedWithExtension({
  extension,
  root,
}: {
  extension: string;
  root: string;
}) {
  // The reviewed pair lives under the process cwd: a session's reload bounds are
  // seeded from it, so a diff assembled somewhere else would be refused before
  // the watch ever mattered.
  const reviewDir = mkdtempSync(join(process.cwd(), ".hunk-mode-reload-"));
  tempDirs.push(reviewDir);
  const left = join(reviewDir, "before.ts");
  const right = join(reviewDir, "after.ts");
  writeFileSync(left, "export const answer = 41;\n");
  writeFileSync(right, "export const answer = 42;\n");
  const bootstrap = await loadAppBootstrap({
    kind: "diff",
    left,
    right,
    options: { mode: "stack", watch: true },
  });
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
  bootstrap.extensions = extensions;
  const watch = createWatchTestRuntime();
  const setup = await testRender(
    <AppHost bootstrap={bootstrap} onQuit={() => {}} watchRuntime={watch.runtime} />,
    { width: 120, height: 24 },
  );
  return { notices, right, setup, watch };
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
  test("enters in one step from raw diff, selecting the view it takes keys for", async () => {
    const { notices, setup } = await renderWithExtension(createInteractiveModeExtension());

    try {
      // The file is on raw diff: nothing selected the view first.
      const initial = await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      expect(initial).not.toContain("CURSOR 0");

      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ENTER RESULT true");
      expect(notices).toContain("MODE ACTIVE true");

      // One press both put the view on screen and gave its mode the keyboard,
      // and the auto-exit effect left the fresh mode alone rather than racing
      // the selection it was entered with.
      await waitForFrame(
        setup,
        (frame) =>
          frame.includes("CURSOR 0") && frame.includes("interactive-view:outline mode — Esc exits"),
      );
      for (let settle = 0; settle < 5; settle += 1) {
        await act(async () => {
          await setup.renderOnce();
          await Bun.sleep(20);
        });
      }
      expect(setup.captureCharFrame()).toContain("interactive-view:outline mode — Esc exits");
      expect(notices).not.toContain("MODE EXIT alpha.ts");
      // Entered exactly once, so `onEnter` describes one entry.
      expect(notices.filter((notice) => notice === "MODE ENTER alpha.ts")).toHaveLength(1);

      // And the mode really holds the keyboard afterwards.
      await act(async () => setup.mockInput.typeText("j"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR 1"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

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

      // "exit": the key is consumed and the mode ends.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "MODE ENTER alpha.ts");
      await waitForFrame(setup, (frame) => frame.includes("CURSOR 0"));
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
      // (One press re-selects the toggled-away view and re-enters its mode.)
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("CURSOR"));
      await act(async () => setup.mockInput.typeText("."));
      await waitForFrame(setup, () => notices.filter((n) => n === "MODE EXIT alpha.ts").length > 3);
      expect(setup.captureCharFrame()).not.toContain("mode — Esc exits");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("refuses to enter an unknown view, a view with no mode, or one that does not match", async () => {
    const { notices, setup } = await renderWithExtension(createInteractiveModeExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));

      // A mode whose view never claims the file: no selection could put its
      // rows on screen, so entering cannot make them visible either.
      await act(async () => setup.mockInput.pressKey("F4"));
      await waitForNotice(setup, notices, "PICKY RESULT false");
      await waitForFrame(setup, (frame) =>
        frame.includes('File view "picky" does not match the selected file'),
      );
      expect(setup.captureCharFrame()).not.toContain("mode — Esc exits");
      // Nothing was selected on the way to the refusal either.
      expect(setup.captureCharFrame()).not.toContain("CURSOR 0");

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

  test("entering a second mode exits the first before the new one starts", async () => {
    const { notices, setup } = await renderWithExtension(createModeHandoffExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));

      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ALPHA RESULT true");
      await waitForFrame(setup, (frame) => frame.includes("mode-handoff:alpha mode — Esc exits"));

      await act(async () => setup.mockInput.pressKey("F7"));
      await waitForNotice(setup, notices, "BETA RESULT true");
      await waitForFrame(setup, (frame) => frame.includes("mode-handoff:beta mode — Esc exits"));

      // The replaced mode is owed its teardown exactly once, and it runs before
      // the replacement starts rather than being skipped.
      expect(notices.filter((notice) => notice === "EXIT alpha")).toHaveLength(1);
      expect(notices.indexOf("EXIT alpha")).toBeLessThan(notices.indexOf("ENTER beta"));
      expect(notices).not.toContain("EXIT beta");

      // And the keyboard belongs to the mode that replaced it.
      await act(async () => setup.mockInput.typeText("n"));
      await waitForNotice(setup, notices, "KEY beta n");
      expect(notices).not.toContain("KEY alpha n");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("an exiting key handler does not tear down the mode it handed off to", async () => {
    const { notices, setup } = await renderWithExtension(createModeHandoffExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ALPHA RESULT true");
      await waitForFrame(setup, (frame) => frame.includes("mode-handoff:alpha mode — Esc exits"));

      await act(async () => setup.mockInput.typeText("r"));
      await waitForNotice(setup, notices, "KEY alpha r");
      await waitForFrame(setup, (frame) => frame.includes("mode-handoff:beta mode — Esc exits"));

      expect(notices.filter((notice) => notice === "EXIT alpha")).toHaveLength(1);
      expect(notices.filter((notice) => notice === "ENTER beta")).toHaveLength(1);
      expect(notices).not.toContain("EXIT beta");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("a mode entered after a soft reload belongs to the review the reload produced", async () => {
    const { notices, right, setup, watch } = await renderWatchedWithExtension(
      createDeferredModeExtension(),
    );

    try {
      await waitForFrame(setup, (frame) => frame.includes("after.ts"));

      // The handler parks on its dialog, holding the controls it was dispatched
      // with, and the review moves underneath it.
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("Ready to edit?"));

      writeFileSync(right, "export const answer = 42;\nexport const reloaded = true;\n");
      watch.setSignature("signature:reloaded");
      watch.emit();
      await act(async () => {
        watch.advanceBy(200);
        await Promise.resolve();
      });
      // The reload cancels the dialog, which is both the proof it landed — only
      // a replaced review generation cancels a queued request — and what wakes
      // the handler, which now enters against the review that replaced the one
      // it started in.
      await waitForNotice(setup, notices, "DIALOG ANSWER false");
      await waitForNotice(setup, notices, "LATE RESULT true");
      await waitForFrame(setup, (frame) => frame.includes("mode-reload:editor mode — Esc exits"));

      // And it stays: a mode tagged with the pre-reload review would be torn
      // down by the very next render, `onEnter` and `onExit` back to back.
      for (let settle = 0; settle < 5; settle += 1) {
        await act(async () => {
          await setup.renderOnce();
          await Bun.sleep(20);
        });
      }
      expect(setup.captureCharFrame()).toContain("mode-reload:editor mode — Esc exits");
      expect(notices.filter((notice) => notice.startsWith("MODE ENTER"))).toHaveLength(1);
      expect(notices.filter((notice) => notice.startsWith("MODE EXIT"))).toHaveLength(0);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("a second Escape in one input flush is routed as if no mode were running", async () => {
    const { notices, setup } = await renderWithExtension(createModeHandoffExtension());

    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));

      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForNotice(setup, notices, "ALPHA RESULT true");
      await waitForFrame(setup, (frame) => frame.includes("mode-handoff:alpha mode — Esc exits"));

      // Both keys are published straight to the key handler, back to back, with
      // no chance for a render in between — which is what one input chunk
      // carrying two keys does, and what `mockInput` cannot reproduce because
      // each of its writes settles before the next. The first key ends the mode
      // through its "exit" result; the second belongs to the command table, and
      // a handler answering from the last rendered state would still read "a
      // mode is running" and swallow Escape as the mode's way out.
      await act(async () => {
        setup.renderer.keyInput.emit("keypress", testKeyEvent({ name: "x", sequence: "x" }));
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "escape", sequence: "", raw: "" }),
        );
      });
      await waitForNotice(setup, notices, "EXIT alpha");
      await waitForNotice(setup, notices, "ESCAPE COMMAND RAN");
      // Escape is host-owned while a mode runs, so the mode never saw it.
      expect(notices).not.toContain("KEY alpha escape");
      expect(notices.filter((notice) => notice === "EXIT alpha")).toHaveLength(1);
      expect(notices.filter((notice) => notice === "ESCAPE COMMAND RAN")).toHaveLength(1);
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
