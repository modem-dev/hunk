import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { KeyEvent, type ParsedKey } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../test/helpers/filesystem";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/changeset/loaders";

import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import type { CliInput } from "../core/run/commandInputs";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/** Specialize the core loader result with extension state assigned by these tests. */
function loadAppBootstrap(...args: Parameters<typeof loadCoreAppBootstrap>): Promise<AppBootstrap> {
  const [input, options] = args;
  return loadCoreAppBootstrap(input, {
    vcsCatalog: getBundledVcsCatalog(),
    ...options,
  }) as Promise<AppBootstrap>;
}

/**
 * `ctx.dialogs`, driven through the real app: a fixture extension asks a
 * question from a command handler, the modal renders inside the mounted review,
 * and the keys the user presses are the ones the handler's promise resolves on.
 * Only the whole stack can show that — the queue's own semantics are unit-tested
 * in `lib/extensionDialogs.test.ts`.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTestDirectory(dir);
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Create a Git checkout with two committed files carrying working-tree changes. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  writeFileSync(join(repo, "beta.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "beta.txt"), "one\ntwo\n");
  return repo;
}

function readProbeLog(logPath: string) {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
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

/** Render frames until a condition holds, and fail loudly when it never does. */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
    }

    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/** Launch a bootstrap whose extensions come from one `--extension` fixture path. */
async function launchWithExtension(repo: string, extPath: string): Promise<AppBootstrap> {
  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "stack", extensionPaths: [extPath] } },
    { cwd: repo },
  );
  bootstrap.extensions = await loadStartupExtensions({
    extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
    cwd: repo,
    cliExtensionPaths: [extPath],
  });
  expect(bootstrap.extensions.issues).toEqual([]);
  return bootstrap;
}

/**
 * A broker client stub that captures the bridge App registers with it.
 *
 * The daemon reload path matters to dialogs specifically: it reaches
 * `reloadSession` without passing through the refresh key's wrapper, so it is
 * the reload most likely to leave a stale question standing if cancellation
 * were wired anywhere but the session swap itself.
 */
function createTestBrokerClient() {
  let bridge: { dispatchCommand: (message: unknown) => Promise<unknown> } | null = null;

  const client = {
    setBridge(next: typeof bridge) {
      bridge = next;
    },
    getRegistration() {
      return { sessionId: "test-session" };
    },
    replaceSession() {},
    updateSnapshot() {},
    updateRegistration() {},
    close() {},
  } as unknown as HunkSessionBrokerClient;

  return {
    client,
    /** Reload the way the daemon does, with a freshly parsed input. */
    reload: async (nextInput: CliInput) => {
      if (!bridge) {
        throw new Error("App never registered a session bridge.");
      }

      return await bridge.dispatchCommand({
        type: "command",
        requestId: "test-request",
        command: "reload_session",
        input: { sessionId: "test-session", nextInput },
      });
    },
  };
}

/** Mount one AppHost, run the body, and tear down. */
async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>, quits: () => number) => Promise<void>,
  hostClient?: HunkSessionBrokerClient,
  dimensions: { width: number; height: number } = { width: 140, height: 30 },
) {
  let quitCount = 0;
  const setup = await testRender(
    <AppHost
      bootstrap={bootstrap}
      hostClient={hostClient}
      onQuit={() => {
        quitCount += 1;
      }}
    />,
    dimensions,
  );

  try {
    await flush(setup);
    await body(setup, () => quitCount);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/** Find the first terminal coordinate occupied by one rendered text fragment. */
function findTextPosition(frame: string, text: string) {
  const lines = frame.split("\n");
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y]!.indexOf(text);
    if (x >= 0) return { x, y };
  }
  return null;
}

/**
 * Write a fixture whose `y` command runs one dialog call and logs its result.
 *
 * `askSource` is the expression the handler awaits, so each test differs only
 * in the question it asks.
 */
function writeDialogFixture(extPath: string, logPath: string, askSource: string) {
  writeFileSync(
    extPath,
    `import { appendFileSync } from "node:fs";\n` +
      `import { createElement, useState } from "react";\n` +
      `import { useKeyboard } from "@opentui/react";\n` +
      `import { matchesKey } from "hunkdiff/extension";\n` +
      `function createCopyDialog(body, label, text) {\n` +
      `  return function CopyDialog({ actions, copySupported, height, theme, width }) {\n` +
      `    const copyExposed = width >= 5 && height >= 4;\n` +
      `    const copy = () => {\n` +
      `      const copied = actions.copy(text);\n` +
      `      actions.notify(copied ? "Copied custom content to clipboard" : "Clipboard copy failed");\n` +
      `    };\n` +
      `    useKeyboard((key) => {\n` +
      `      if (!copySupported || !copyExposed || !matchesKey("c", key)) return;\n` +
      `      key.preventDefault();\n` +
      `      key.stopPropagation();\n` +
      `      copy();\n` +
      `    });\n` +
      `    return createElement("box", { style: { width, height, flexDirection: "column", overflow: "hidden" } },\n` +
      `      createElement("box", { style: { width: "100%", height: 1 } }, createElement("text", { fg: theme.text }, body)),\n` +
      `      createElement("box", { style: { width: "100%", height: 1 } }, createElement("text", { fg: theme.badgeNeutral }, label)),\n` +
      `      createElement("box", { style: { width: "100%", height: 1 } }, createElement("text", { fg: theme.text }, text)),\n` +
      `      createElement("box", { style: { width: "100%", height: 1, backgroundColor: copySupported ? theme.accentMuted : theme.panelAlt }, onMouseUp: (event) => { event.stopPropagation(); if (copySupported && copyExposed) copy(); } },\n` +
      `        createElement("text", { fg: copySupported ? theme.text : theme.muted }, copySupported ? " ⧉  Copy " + label.toLowerCase() + " " : " Copy unavailable "))\n` +
      `    );\n` +
      `  };\n` +
      `}\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {\n` +
      `    const answer = await ${askSource};\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "answer " + String(answer) + "\\n");\n` +
      `  });\n` +
      `}\n`,
  );
}

describe("extension dialogs", () => {
  test("dialogs cancel immediately instead of queueing while an application owns the terminal", async () => {
    const repo = createTestRepo("hunk-ext-dialog-app-owner-");
    const extDir = createTempDir("hunk-ext-dialog-app-owner-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "ask-in-app", title: "Ask in app", key: "y" }, async (ctx) => {\n` +
        `    const pending = ctx.dialogs.confirm({ title: "Already queued confirm" });\n` +
        `    const answers = await ctx.openInApp(async () => await Promise.all([\n` +
        `      pending,\n` +
        `      ctx.dialogs.confirm({ title: "Invisible confirm" }),\n` +
        `      ctx.dialogs.select({ title: "Invisible select", options: ["one"] }),\n` +
        `      ctx.dialogs.input({ title: "Invisible input" }),\n` +
        `    ]));\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(answers) + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("[false,false,null,null]"),
        "the app-owned dialogs to resolve their cancel values",
      );

      const frame = setup.captureCharFrame();
      expect(frame).toContain("alpha.txt");
      expect(frame).not.toContain("Already queued confirm");
      expect(frame).not.toContain("Invisible confirm");
      expect(frame).not.toContain("Invisible select");
      expect(frame).not.toContain("Invisible input");
    });
  });

  test("a confirm dialog renders with attribution and resolves true on enter", async () => {
    const repo = createTestRepo("hunk-ext-dialog-confirm-");
    // Outside the repo, so the fixture and its log never join the review.
    const extDir = createTempDir("hunk-ext-dialog-confirm-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.confirm({ title: "Reformat the file?", body: "This rewrites it in place.", confirmLabel: "reformat" })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup, quits) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Reformat the file?"),
        "the confirm dialog to open",
      );

      const frame = setup.captureCharFrame();
      expect(frame).toContain("This rewrites it in place.");
      expect(frame).toContain("reformat");
      // The dialog names the extension that raised it, so a prompt cannot
      // present itself as Hunk asking. The fixture is loaded from a file, so
      // its id is the file's basename.
      expect(frame).toContain("ext ext");

      // A global shortcut must not fire behind an open dialog.
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      expect(quits()).toBe(0);
      expect(setup.captureCharFrame()).toContain("Reformat the file?");

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer true"),
        "the handler to resolve true",
      );
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("Reformat the file?"),
        "the dialog to close",
      );
    });
  });

  test("owns later keys when a command opens and cancels a dialog in one input flush", async () => {
    const repo = createTestRepo("hunk-ext-dialog-same-flush-");
    const extDir = createTempDir("hunk-ext-dialog-same-flush-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(extPath, logPath, `ctx.dialogs.confirm({ title: "Same flush?" })`);

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "y", sequence: "y", raw: "y" }),
        );
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "q", sequence: "q", raw: "q" }),
        );
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "escape", sequence: "\u001b", raw: "\u001b" }),
        );
      });

      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer false"),
        "the same-flush Escape to cancel the queued dialog",
      );
      expect(quits()).toBe(0);
      expect(setup.captureCharFrame()).not.toContain("Same flush?");
    });
  });

  test("moves and accepts a newly opened select dialog in one input flush", async () => {
    const repo = createTestRepo("hunk-ext-dialog-select-same-flush-");
    const extDir = createTempDir("hunk-ext-dialog-select-same-flush-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.select({ title: "Same flush choice", options: ["one", "two"] })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        setup.renderer.keyInput.emit(
          "keypress",
          testKeyEvent({ name: "y", sequence: "y", raw: "y" }),
        );
        setup.renderer.keyInput.emit("keypress", testKeyEvent({ name: "down" }));
        setup.renderer.keyInput.emit("keypress", testKeyEvent({ name: "return" }));
      });

      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer two"),
        "the same-flush selection to resolve",
      );
      expect(setup.captureCharFrame()).not.toContain("Same flush choice");
    });
  });

  test("a component dialog renders an OpenTUI surface and closes only on escape", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-");
    const extDir = createTempDir("hunk-ext-dialog-open-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Agent setup", width: 46, height: 6, component: createCopyDialog("Teach your agent how to review this Hunk session.", "Prompt", "Load the Hunk skill and use it for this review. Run hunk skill path to get the skill path.") })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        const copied: string[] = [];
        setup.renderer.isOsc52Supported = () => true;
        setup.renderer.copyToClipboardOSC52 = (text: string) => {
          copied.push(text);
          return true;
        };

        await act(async () => {
          await setup.mockInput.typeText("y");
        });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Agent setup"),
          "the component dialog to open",
        );

        const frame = setup.captureCharFrame();
        expect(frame).toContain("Teach your agent");
        expect(frame).toContain("Prompt");
        expect(frame).toContain("Load the Hunk skill");
        expect(frame).toContain("ext ext");

        await act(async () => {
          await setup.mockInput.pressEnter();
          await setup.mockInput.typeText("c");
        });
        await flush(setup);
        expect(setup.captureCharFrame()).toContain("Agent setup");
        expect(copied).toEqual([
          "Load the Hunk skill and use it for this review. Run hunk skill path to get the skill path.",
        ]);

        const copyAction = findTextPosition(setup.captureCharFrame(), "Copy prompt");
        expect(copyAction).not.toBeNull();
        await act(async () => {
          await setup.mockMouse.click(copyAction!.x, copyAction!.y);
        });
        expect(copied).toHaveLength(2);

        await act(async () => {
          await setup.mockInput.pressEscape();
        });
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("answer undefined"),
          "the component-dialog handler to finish",
        );
      },
      undefined,
      { width: 50, height: 20 },
    );
  });

  test("preserves focus owned by an input inside a component dialog", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-input-");
    const extDir = createTempDir("hunk-ext-dialog-open-input-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Custom input", width: 36, height: 4, component: function InputDialog({ theme, width }) { const [value, setValue] = useState(""); return createElement("input", { focused: true, width, value, onInput: setValue, textColor: theme.text }); } })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Custom input"),
        "the custom input dialog to open",
      );

      await act(async () => {
        await setup.mockInput.typeText("quick-fix");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("quick-fix"),
        "typing to reach the extension-owned input",
      );
      expect(quits()).toBe(0);

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () =>
          readProbeLog(logPath).includes("answer undefined") &&
          !setup.captureCharFrame().includes("Custom input"),
        "the custom input dialog to settle and close",
      );
    });
  });

  test("keeps a promoted input focused after a component dialog closes", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-input-promotion-");
    const extDir = createTempDir("hunk-ext-dialog-open-input-promotion-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { createElement } from "react";\n` +
        `import { useKeyboard } from "@opentui/react";\n` +
        `import { matchesKey } from "hunkdiff/extension";\n` +
        `function FirstDialog({ actions, theme }) {\n` +
        `  useKeyboard((key) => { if (matchesKey("x", key)) actions.close(); });\n` +
        `  return createElement("text", { fg: theme.text }, "Press x for input");\n` +
        `}\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {\n` +
        `    const opened = ctx.dialogs.open({ title: "First component", component: FirstDialog });\n` +
        `    const typed = ctx.dialogs.input({ title: "Promoted input" });\n` +
        `    const results = await Promise.all([opened, typed]);\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "answer " + String(results[1]) + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    bootstrap.input.options.pager = true;
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Press x for input"),
        "the first component dialog to open",
      );

      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Promoted input"),
        "the queued input dialog to be promoted",
      );
      expect(setup.renderer.currentFocusedRenderable?.constructor.name).toBe("InputRenderable");

      await act(async () => {
        await setup.mockInput.typeText("quick-fix");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("quick-fix"),
        "typing to remain with the promoted input",
      );
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer quick-fix"),
        "the promoted input to resolve its typed value",
      );
    });
  });

  test("clips a custom component to the bounded rectangle beneath attribution", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-short-");
    const extDir = createTempDir("hunk-ext-dialog-open-short-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Agent setup", width: 46, height: 6, component: createCopyDialog("Teach your agent how to review this Hunk session.", "Prompt", "Load the Hunk skill and use it for this review. Run hunk skill path to get the skill path.") })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        const copied: string[] = [];
        setup.renderer.isOsc52Supported = () => true;
        setup.renderer.copyToClipboardOSC52 = (text: string) => {
          copied.push(text);
          return true;
        };

        await act(async () => {
          await setup.mockInput.typeText("y");
        });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Agent setup"),
          "the constrained component dialog to open",
        );

        const frame = setup.captureCharFrame();
        expect(frame).toContain("ext ext");
        expect(frame).not.toContain("Copy prompt");

        await act(async () => {
          await setup.mockInput.typeText("c");
        });
        await flush(setup);
        expect(copied).toEqual([]);
        expect(setup.captureCharFrame()).toContain("Agent setup");
      },
      undefined,
      { width: 50, height: 12 },
    );
  });

  test("an unavailable component copy action is visible but inert", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-unavailable-");
    const extDir = createTempDir("hunk-ext-dialog-open-unavailable-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Copy setup", width: 46, height: 6, component: createCopyDialog("Copy this text.", "Prompt", "copy me") })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      const copied: string[] = [];
      setup.renderer.isOsc52Supported = () => false;
      setup.renderer.copyToClipboardOSC52 = (text: string) => {
        copied.push(text);
        return true;
      };

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Copy unavailable"),
        "the unavailable copy state to render",
      );

      const unavailable = findTextPosition(setup.captureCharFrame(), "Copy unavailable");
      expect(unavailable).not.toBeNull();
      await act(async () => {
        await setup.mockInput.typeText("c");
        await setup.mockMouse.click(unavailable!.x, unavailable!.y);
      });
      await flush(setup);

      expect(copied).toEqual([]);
      expect(setup.captureCharFrame()).toContain("Copy setup");

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer undefined"),
        "the unavailable-copy component dialog to close",
      );
    });
  });

  test("reports a clipboard write rejected by the renderer as a failure", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-copy-failure-");
    const extDir = createTempDir("hunk-ext-dialog-open-copy-failure-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Copy setup", width: 46, height: 6, component: createCopyDialog("Copy this text.", "Prompt", "copy me") })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      let attempts = 0;
      setup.renderer.isOsc52Supported = () => true;
      setup.renderer.copyToClipboardOSC52 = () => {
        attempts += 1;
        return false;
      };

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Copy prompt"),
        "the copy action to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("c");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Clipboard copy failed"),
        "the copy failure notice",
      );

      expect(attempts).toBe(1);
      expect(setup.captureCharFrame()).not.toContain("Copied custom content to clipboard");
    });
  });

  test("contains a custom component render failure inside its dismissible frame", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-render-failure-");
    const extDir = createTempDir("hunk-ext-dialog-open-render-failure-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Broken surface", width: 30, height: 4, component: ({ actions }) => { const retained = actions; setTimeout(() => { appendFileSync(${JSON.stringify(logPath)}, "failed-copy " + String(retained.copy("stale")) + "\\n"); retained.notify("stale failure notice"); retained.close(); appendFileSync(${JSON.stringify(logPath)}, "failed-actions-called\\n"); }, 10); throw new Error("surface exploded"); } })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      const copied: string[] = [];
      setup.renderer.isOsc52Supported = () => true;
      setup.renderer.copyToClipboardOSC52 = (text: string) => {
        copied.push(text);
        return true;
      };
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Dialog unavailable"),
        "the custom-dialog fallback to render",
      );

      const failed = setup.captureCharFrame();
      expect(failed).toContain("Broken surface");
      expect(failed).toContain("surface exploded");
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("failed-actions-called"),
        "the retained failed-component actions to run",
      );
      expect(readProbeLog(logPath)).toContain("failed-copy false");
      expect(copied).toEqual([]);
      expect(setup.captureCharFrame()).toContain("Dialog unavailable");
      expect(setup.captureCharFrame()).not.toContain("stale failure notice");

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer undefined"),
        "the failed component dialog to close",
      );
    });
  });

  test("keeps a custom component mounted through a zero-row terminal allocation", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-zero-height-");
    const extDir = createTempDir("hunk-ext-dialog-open-zero-height-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Resize surface", width: 30, height: 4, component: function StatefulDialog({ height, theme }) { const [value, setValue] = useState("initial"); useKeyboard((key) => { if (matchesKey("x", key)) setValue("preserved"); }); return createElement("text", { fg: theme.text }, value + " at " + height); } })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("initial at 4"),
        "the stateful component to open",
      );

      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("preserved at 4"),
        "the stateful component to update before shrinking",
      );

      await act(async () => {
        await setup.resize(80, 8);
      });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("preserved at");

      await act(async () => {
        await setup.resize(80, 20);
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("preserved at 4"),
        "the zero-row component state to survive the resize",
      );

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer undefined"),
        "the resized component dialog to close",
      );
    });
  });

  test("routes component keys without exposing the review and honors guarded close", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-close-");
    const extDir = createTempDir("hunk-ext-dialog-open-close-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.open({ title: "Component keys", width: 30, height: 4, component: function KeyDialog({ actions, theme }) { useKeyboard((key) => { if (matchesKey("x", key)) actions.close(); }); return createElement("text", { fg: theme.text }, "Press x to close"); } })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Press x to close"),
        "the keyed component dialog to open",
      );

      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flushUntil(
        setup,
        () =>
          readProbeLog(logPath).includes("answer undefined") &&
          !setup.captureCharFrame().includes("Component keys"),
        "the component action to settle and close its dialog",
      );
    });
  });

  test("remounts reused components and retires actions when the queue advances", async () => {
    const repo = createTestRepo("hunk-ext-dialog-open-lease-");
    const extDir = createTempDir("hunk-ext-dialog-open-lease-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { createElement, useState } from "react";\n` +
        `import { useKeyboard } from "@opentui/react";\n` +
        `import { matchesKey } from "hunkdiff/extension";\n` +
        `let mounts = 0;\n` +
        `let firstActions;\n` +
        `function SharedDialog({ actions, theme }) {\n` +
        `  const [mount] = useState(() => ++mounts);\n` +
        `  if (mount === 1) firstActions = actions;\n` +
        `  useKeyboard((key) => {\n` +
        `    if (matchesKey("x", key)) actions.close();\n` +
        `    if (matchesKey("z", key) && firstActions) {\n` +
        `      appendFileSync(${JSON.stringify(logPath)}, "stale-copy " + String(firstActions.copy("stale")) + "\\n");\n` +
        `      firstActions.notify("stale notification");\n` +
        `      firstActions.close();\n` +
        `    }\n` +
        `  });\n` +
        `  return createElement("text", { fg: theme.text }, "mount " + mount);\n` +
        `}\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {\n` +
        `    await Promise.all([\n` +
        `      ctx.dialogs.open({ title: "First surface", component: SharedDialog }),\n` +
        `      ctx.dialogs.open({ title: "Second surface", component: SharedDialog }),\n` +
        `    ]);\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "settled\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      const copied: string[] = [];
      setup.renderer.isOsc52Supported = () => true;
      setup.renderer.copyToClipboardOSC52 = (text: string) => {
        copied.push(text);
        return true;
      };

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("mount 1"),
        "the first reused component to mount",
      );

      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("Second surface") && frame.includes("mount 2");
        },
        "the reused component to remount for the promoted request",
      );

      await act(async () => {
        await setup.mockInput.typeText("z");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("stale-copy false"),
        "the retired copy action to report that it is inert",
      );
      const promotedFrame = setup.captureCharFrame();
      expect(promotedFrame).toContain("Second surface");
      expect(promotedFrame).not.toContain("stale notification");
      expect(copied).toEqual([]);

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () =>
          readProbeLog(logPath).includes("settled") &&
          !setup.captureCharFrame().includes("Second surface"),
        "the promoted component dialog to settle and close",
      );
    });
  });

  test("keeps confirm actions visible when wrapped prose exceeds a short terminal", async () => {
    const repo = createTestRepo("hunk-ext-dialog-short-confirm-");
    const extDir = createTempDir("hunk-ext-dialog-short-confirm-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.confirm({ title: "Short terminal", body: "This deliberately long explanation wraps across many rows but must never displace the primary actions from the modal footer." })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await act(async () => {
          await setup.mockInput.typeText("y");
        });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Short terminal"),
          "the short confirm dialog to open",
        );

        const frame = setup.captureCharFrame();
        expect(frame).toContain("…");
        expect(frame).toContain("enter/y");
        expect(frame).toContain("esc/n");
      },
      undefined,
      { width: 50, height: 12 },
    );
  });

  test("escape resolves a confirm dialog as false", async () => {
    const repo = createTestRepo("hunk-ext-dialog-escape-");
    const extDir = createTempDir("hunk-ext-dialog-escape-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(extPath, logPath, `ctx.dialogs.confirm({ title: "Discard the draft?" })`);

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Discard the draft?"),
        "the confirm dialog to open",
      );

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer false"),
        "the handler to resolve false",
      );
    });
  });

  test("a select dialog resolves the option the arrow keys land on", async () => {
    const repo = createTestRepo("hunk-ext-dialog-select-");
    const extDir = createTempDir("hunk-ext-dialog-select-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.select({ title: "Where to?", options: ["staging", "production", "canary"] })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("Where to?") && frame.includes("production");
        },
        "the select dialog to list its options",
      );

      await act(async () => {
        await setup.mockInput.pressArrow("down");
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer production"),
        "the handler to resolve the highlighted option",
      );
    });
  });

  test("clicking a select option accepts that exact row", async () => {
    const repo = createTestRepo("hunk-ext-dialog-select-mouse-");
    const extDir = createTempDir("hunk-ext-dialog-select-mouse-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.select({ title: "Mouse target?", options: ["staging", "production", "canary"] })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("production"),
        "the mouse select dialog to open",
      );

      const target = findTextPosition(setup.captureCharFrame(), "production");
      expect(target).not.toBeNull();
      await act(async () => {
        await setup.mockMouse.click(target!.x, target!.y);
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer production"),
        "the clicked option to resolve",
      );
    });
  });

  test("an input dialog resolves the typed text", async () => {
    const repo = createTestRepo("hunk-ext-dialog-input-");
    const extDir = createTempDir("hunk-ext-dialog-input-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(
      extPath,
      logPath,
      `ctx.dialogs.input({ title: "Branch name?", placeholder: "feature/..." })`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup, quits) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("alpha.txt"),
        "the review to render",
      );

      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Branch name?"),
        "the input dialog to open",
      );

      // Typing reaches the focused field instead of the review's shortcuts, so
      // the `q` in "quick" neither quits nor is swallowed.
      await act(async () => {
        await setup.mockInput.typeText("quick-fix");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("quick-fix"),
        "the typed text to reach the focused field",
      );
      expect(quits()).toBe(0);

      const submit = findTextPosition(setup.captureCharFrame(), "submit");
      expect(submit).not.toBeNull();
      await act(async () => {
        await setup.mockMouse.click(submit!.x, submit!.y);
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer quick-fix"),
        "the mouse action to submit the typed text",
      );
    });
  });

  test("a daemon-driven session reload cancels the open dialog", async () => {
    const repo = createTestRepo("hunk-ext-dialog-reload-");
    const extDir = createTempDir("hunk-ext-dialog-reload-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeDialogFixture(extPath, logPath, `ctx.dialogs.confirm({ title: "Still relevant?" })`);

    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("alpha.txt"),
          "the review to render",
        );

        await act(async () => {
          await setup.mockInput.typeText("y");
        });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Still relevant?"),
          "the confirm dialog to open",
        );

        // The daemon path reaches reloadSession without the refresh key's
        // wrapper, so this is the reload that would leave the question
        // standing if cancellation hung off any single call site.
        const reload = broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => {
            const frame = setup.captureCharFrame();
            return !frame.includes("Still relevant?") && frame.includes("alpha.txt");
          },
          "the reload to close the dialog over the replacement review",
        );
        await reload;
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("answer false"),
          "the handler to resolve the dialog's cancel value",
        );
      },
      broker.client,
    );
  });

  test("retires component actions before a soft-reload layout cleanup", async () => {
    const repo = createTestRepo("hunk-ext-dialog-reload-action-lease-");
    const extDir = createTempDir("hunk-ext-dialog-reload-action-lease-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { createElement, useLayoutEffect } from "react";\n` +
        `function CleanupDialog({ actions, theme }) {\n` +
        `  useLayoutEffect(() => () => {\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "cleanup-copy " + String(actions.copy("stale")) + "\\n");\n` +
        `    actions.notify("stale cleanup notice");\n` +
        `    actions.close();\n` +
        `  }, []);\n` +
        `  return createElement("text", { fg: theme.text }, "Reload cleanup probe");\n` +
        `}\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {\n` +
        `    await ctx.dialogs.open({ title: "Reload action lease", component: CleanupDialog });\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "settled\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        const copied: string[] = [];
        setup.renderer.isOsc52Supported = () => true;
        setup.renderer.copyToClipboardOSC52 = (text: string) => {
          copied.push(text);
          return true;
        };
        await act(async () => {
          await setup.mockInput.typeText("y");
        });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Reload cleanup probe"),
          "the cleanup-probe component dialog to open",
        );

        await broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => {
            const events = readProbeLog(logPath);
            return events.includes("cleanup-copy false") && events.includes("settled");
          },
          "the stale cleanup actions to retire before reload teardown",
        );

        expect(copied).toEqual([]);
        expect(setup.captureCharFrame()).not.toContain("stale cleanup notice");
      },
      broker.client,
    );
  });

  test("keeps a dialog opened by the replacement generation's reload lifecycle", async () => {
    const repo = createTestRepo("hunk-ext-dialog-reload-lifecycle-");
    const extDir = createTempDir("hunk-ext-dialog-reload-lifecycle-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("session_reload", async (_payload, ctx) => {\n` +
        `    const answer = await ctx.dialogs.confirm({ title: "Review reloaded" });\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "answer " + String(answer) + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );

    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("alpha.txt"),
          "the initial review to render",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("Review reloaded"),
          "the replacement lifecycle dialog to remain open",
        );
        await reload;
        expect(readProbeLog(logPath)).toEqual([]);

        await act(async () => {
          await setup.mockInput.pressEnter();
        });
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("answer true"),
          "the replacement lifecycle dialog to resolve normally",
        );
      },
      broker.client,
    );
  });
});
