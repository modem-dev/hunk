import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { KeyEvent, type ParsedKey } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a real extension using both session and file-view keyboard modes. */
function createKeyboardModeExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-keyboard-mode-"));
  tempDirs.push(root);
  const extension = join(root, "keyboard-probe");
  mkdirSync(extension, { recursive: true });
  writeFileSync(
    join(extension, "package.json"),
    JSON.stringify({ name: "keyboard-probe", private: true, hunk: { extensions: ["./index.ts"] } }),
  );
  writeFileSync(
    join(extension, "index.ts"),
    `export default function (hunk) {
  hunk.registerKeyboardMode({
    id: "normal",
    title: "Probe normal",
    onEnter: (ctx) => ctx.notify("SESSION ENTER"),
    onExit: (ctx) => {
      ctx.notify("SESSION EXIT");
      ctx.notify("SESSION REENTER " + ctx.keyboardModes.enterMode("normal"));
    },
    onKey: (key, ctx) => {
      const pressed = key.sequence || key.name;
      ctx.notify("SESSION KEY " + pressed);
      if (pressed === "j" || pressed === "?") return "handled";
      if (pressed === "x") return "exit";
      return "pass";
    },
  });
  hunk.registerFileView({
    id: "focused",
    title: "Focused",
    matches: () => true,
    layout: ({ file }) => ({
      rows: [{ id: "focused", spans: [{ text: "FOCUSED VIEW" }] }],
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: {
      onEnter: (ctx) => ctx.notify("FILE ENTER"),
      onExit: (ctx) => ctx.notify("FILE EXIT"),
      onKey: (key, ctx) => {
        const pressed = key.sequence || key.name;
        ctx.notify("FILE KEY " + pressed);
        return pressed === "?" ? "handled" : "pass";
      },
    },
  });
  hunk.registerCommand({ id: "session", title: "Toggle probe mode", key: "f8" }, (ctx) => {
    if (ctx.keyboardModes.isActive("normal")) ctx.keyboardModes.exitMode();
    else ctx.keyboardModes.enterMode("normal");
  });
  hunk.registerCommand({ id: "file", title: "Enter focused view", key: "f9" }, (ctx) =>
    ctx.fileViews.enterMode("focused"),
  );
  hunk.registerCommand({ id: "passed", title: "Passed command", key: "p" }, (ctx) =>
    ctx.notify("COMMAND P"),
  );
}
`,
  );
  return { extension, root };
}

/** Boot AppHost with one real extension and capture its notices. */
async function renderWithExtension() {
  const { extension, root } = createKeyboardModeExtension();
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
    changesetId: "keyboard-mode",
    files: [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
    initialMode: "stack",
    inputMode: "stack",
  });
  bootstrap.extensions = extensions;
  const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
    width: 120,
    height: 24,
  });
  return { bootstrap, extensions, notices, setup };
}

/** Render until one frame satisfies a predicate. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(10);
    });
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
  }
  throw new Error(`Timed out waiting for frame:\n${setup.captureCharFrame()}`);
}

/** Publish one key synchronously, used for same-input-flush coverage. */
function testKeyEvent(fields: Partial<ParsedKey>) {
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

describe("AppHost session keyboard modes", () => {
  test("routes handled/pass keys and keeps modal and focused input precedence", async () => {
    const { notices, setup } = await renderWithExtension();
    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("Probe normal"));

      await act(async () => setup.mockInput.typeText("j"));
      expect(notices).toContain("SESSION KEY j");
      await act(async () => setup.mockInput.typeText("p"));
      expect(notices).toContain("SESSION KEY p");
      expect(notices).toContain("COMMAND P");

      // Menus outrank the session mode and remain a host-owned escape path.
      await act(async () => setup.mockInput.pressKey("F10"));
      await waitForFrame(setup, (frame) => frame.includes("Reload"));
      expect(notices).not.toContain("SESSION KEY f10");
      await act(async () => setup.mockInput.pressKey("F10"));
      await waitForFrame(setup, (frame) => !frame.includes("Reload"));
      expect(setup.captureCharFrame()).toContain("Probe normal");

      // The mode passes `/`; once the filter owns focus, its text never reaches the mode.
      await act(async () => setup.mockInput.typeText("/"));
      await waitForFrame(setup, (frame) => frame.includes("filter:"));
      const jCount = notices.filter((notice) => notice === "SESSION KEY j").length;
      await act(async () => setup.mockInput.typeText("j"));
      expect(notices.filter((notice) => notice === "SESSION KEY j")).toHaveLength(jCount);
      await act(async () => setup.mockInput.pressTab());
      await act(async () => setup.mockInput.typeText("j"));
      expect(notices.filter((notice) => notice === "SESSION KEY j")).toHaveLength(jCount + 1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("routes open-menu accelerators before extension keyboard modes", async () => {
    const { notices, setup } = await renderWithExtension();
    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(
        setup,
        (frame) => frame.includes("FOCUSED VIEW") && frame.includes("Probe normal"),
      );

      await act(async () => setup.mockInput.pressKey("F10"));
      await waitForFrame(setup, (frame) => frame.includes("Reload"));
      await act(async () => setup.mockInput.typeText("?"));
      const help = await waitForFrame(setup, (frame) => frame.includes("Controls help"));

      expect(help).not.toContain("Reload");
      expect(notices).not.toContain("FILE KEY ?");
      expect(notices).not.toContain("SESSION KEY ?");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("gives a focused file-view mode first Escape and the session mode the second", async () => {
    const { notices, setup } = await renderWithExtension();
    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(
        setup,
        (frame) => frame.includes("FOCUSED VIEW") && frame.includes("Probe normal"),
      );

      await act(async () => {
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "escape", sequence: "\u001b", raw: "\u001b" }),
        );
      });
      expect(notices).toContain("FILE EXIT");
      expect(notices).not.toContain("SESSION EXIT");
      expect(setup.captureCharFrame()).toContain("Probe normal");

      await act(async () => {
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "escape", sequence: "\u001b", raw: "\u001b" }),
        );
      });
      await waitForFrame(setup, (frame) => !frame.includes("Probe normal"));
      expect(notices).toContain("SESSION EXIT");
      expect(notices).toContain("SESSION REENTER false");
      expect(notices).not.toContain("FILE KEY escape");
      expect(notices).not.toContain("SESSION KEY escape");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("updates ownership eagerly for two Escapes in one input flush", async () => {
    const { notices, setup } = await renderWithExtension();
    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("FOCUSED VIEW"));

      await act(async () => {
        const escape = { name: "escape", sequence: "\u001b", raw: "\u001b" };
        setup.renderer.keyInput.emit("keypress", testKeyEvent(escape));
        setup.renderer.keyInput.emit("keypress", testKeyEvent(escape));
      });
      expect(notices.filter((notice) => notice === "FILE EXIT")).toHaveLength(1);
      expect(notices.filter((notice) => notice === "SESSION EXIT")).toHaveLength(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("retires closed registry authority before delivering another key", async () => {
    const { extensions, notices, setup } = await renderWithExtension();
    try {
      await waitForFrame(setup, (frame) => frame.includes("alpha.ts"));
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("Probe normal"));

      extensions.registry.eventBusPhase = "closed";
      const before = notices.filter((notice) => notice === "SESSION KEY j").length;
      await act(async () => setup.mockInput.typeText("j"));
      expect(notices.filter((notice) => notice === "SESSION KEY j")).toHaveLength(before);
      expect(notices.filter((notice) => notice === "SESSION EXIT")).toHaveLength(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
