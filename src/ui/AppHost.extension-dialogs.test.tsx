import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../test/helpers/filesystem";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/loaders";

import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import type { CliInput } from "../core/types";
import type { HunkSessionBrokerClient } from "../session/types";
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
 * in `ext/extensionDialogs.test.ts`.
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
    { width: 140, height: 30 },
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
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "ask", title: "Ask", key: "y" }, async (ctx) => {\n` +
      `    const answer = await ${askSource};\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "answer " + String(answer) + "\\n");\n` +
      `  });\n` +
      `}\n`,
  );
}

describe("extension dialogs", () => {
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

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer quick-fix"),
        "the handler to resolve the typed text",
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
        await act(async () => {
          await broker.reload({ kind: "vcs", staged: false, options: {} });
        });
        await flushUntil(
          setup,
          () => {
            const frame = setup.captureCharFrame();
            return !frame.includes("Still relevant?") && frame.includes("alpha.txt");
          },
          "the reload to close the dialog over the replacement review",
        );
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("answer false"),
          "the handler to resolve the dialog's cancel value",
        );
      },
      broker.client,
    );
  });
});
