import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/changeset/loaders";
import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import type { CliInput } from "../core/run/commandInputs";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import { loadStartupExtensions } from "../extensions/startup";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";

/**
 * `ctx.statusLine` and `ctx.prompts`, driven through the real app: a fixture
 * extension writes to the status row and asks for a line of text from a
 * command handler, and the keys the user presses are what the handler's
 * promise resolves on. The store's own semantics are unit-tested in
 * `statusLine/store.test.ts` and `statusLine/extensionControls.test.ts`.
 */

const tempDirs: string[] = [];
const originalConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  // Trust decisions live in the global state file; keep every test off the developer's real one.
  process.env.XDG_CONFIG_HOME = createTempDir("hunk-status-line-xdg-");
});

afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
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
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}.\n${setup.captureCharFrame()}`,
      );
    }
    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/** Launch a bootstrap whose extensions come from one `--extension` fixture path. */
async function launchWithExtension(repo: string, extPath: string): Promise<AppBootstrap> {
  const bootstrap = (await loadCoreAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "unified", extensionPaths: [extPath] } },
    { cwd: repo, vcsCatalog: getBundledVcsCatalog() },
  )) as AppBootstrap;
  bootstrap.extensions = await loadStartupExtensions({
    extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
    cwd: repo,
    cliExtensionPaths: [extPath],
  });
  expect(bootstrap.extensions.issues).toEqual([]);
  return bootstrap;
}

/** A broker client stub exposing the daemon reload path, which bypasses the refresh key. */
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
    reload: async (nextInput: CliInput) => {
      if (!bridge) throw new Error("App never registered a session bridge.");
      return await bridge.dispatchCommand({
        type: "command",
        requestId: "test-request",
        command: "reload_session",
        input: { sessionId: "test-session", nextInput },
      });
    },
  };
}

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

/** Read the status row: the last non-empty line of the frame. */
function statusRow(frame: string) {
  return frame.trimEnd().split("\n").at(-1) ?? "";
}

/** Write a fixture whose `Y` command runs `body` with `ctx` and a `log(text)` helper. */
function writeCommandFixture(extPath: string, logPath: string, body: string) {
  writeFileSync(
    extPath,
    `import { appendFileSync } from "node:fs";\n` +
      `const log = (text) => appendFileSync(${JSON.stringify(logPath)}, text + "\\n");\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerCommand({ id: "go", title: "Go", key: "Y" }, async (ctx) => {\n` +
      body +
      `  });\n` +
      `}\n`,
  );
}

async function openReview(setup: Awaited<ReturnType<typeof testRender>>) {
  await flushUntil(
    setup,
    () => setup.captureCharFrame().includes("alpha.txt"),
    "the review to render",
  );
}

async function pressY(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.mockInput.typeText("Y");
  });
}

describe("extension status line items", () => {
  test("a command sets an item that keeps the row on screen and clears it again", async () => {
    const repo = createTestRepo("hunk-status-item-");
    const extDir = createTempDir("hunk-status-item-ext-");
    const extPath = join(extDir, "ext.ts");
    // The fixture alternates through a module-level flag, so the second press clears the item.
    writeFileSync(
      extPath,
      `let shown = false;\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerCommand({ id: "go", title: "Go", key: "Y" }, (ctx) => {\n` +
        `    if (shown) {\n` +
        `      ctx.statusLine.clear("count");\n` +
        `    } else {\n` +
        `      ctx.statusLine.set({ id: "count", spans: [{ text: "3 files " }, { text: "viewed", tone: "accent", attributes: ["bold"] }], alignment: "right" });\n` +
        `    }\n` +
        `    shown = !shown;\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      const idle = setup.captureCharFrame();
      expect(idle).not.toContain("viewed");

      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("3 files viewed"),
        "the status item to render",
      );
      // The item took a row from the review and sits on the right edge of it.
      const shown = setup.captureCharFrame();
      expect(statusRow(shown).trimEnd().endsWith("3 files viewed")).toBe(true);

      await pressY(setup);
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("viewed"),
        "the status item to clear",
      );
    });
  });

  test("an event handler can set items and they survive a content reload", async () => {
    const repo = createTestRepo("hunk-status-event-");
    const extDir = createTempDir("hunk-status-event-ext-");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `let loads = 0;\n` +
        `export default function (hunk) {\n` +
        `  hunk.on("changeset_loaded", (_payload, ctx) => {\n` +
        `    loads += 1;\n` +
        `    if (loads === 1) ctx.statusLine.set({ id: "loads", spans: [{ text: "loaded once" }] });\n` +
        `  });\n` +
        `}\n`,
    );

    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await openReview(setup);
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("loaded once"),
          "the event-set item to render",
        );

        // The same registry survives a content reload, and so does its item.
        await broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("alpha.txt"),
          "the reload to render",
        );
        await flush(setup);
        expect(setup.captureCharFrame()).toContain("loaded once");
      },
      broker.client,
    );
  });

  test("a keyboard mode writes its buffer and the exit clears it", async () => {
    const repo = createTestRepo("hunk-status-mode-");
    const extDir = createTempDir("hunk-status-mode-ext-");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(
      extPath,
      `export default function (hunk) {\n` +
        `  hunk.registerKeyboardMode({\n` +
        `    id: "count",\n` +
        `    title: "Counting",\n` +
        `    onEnter: (ctx) => ctx.statusLine.set({ id: "buffer", spans: [{ text: "count=" }] }),\n` +
        `    onExit: (ctx) => ctx.statusLine.clear("buffer"),\n` +
        `    onKey: (key, ctx) => {\n` +
        `      ctx.statusLine.set({ id: "buffer", spans: [{ text: "count=" + key.sequence }] });\n` +
        `      return "handled";\n` +
        `    },\n` +
        `  });\n` +
        `  hunk.registerCommand({ id: "go", title: "Go", key: "Y" }, (ctx) => {\n` +
        `    ctx.keyboardModes.enterMode("count");\n` +
        `  });\n` +
        `}\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("count="),
        "the mode's buffer item to render",
      );
      await act(async () => {
        await setup.mockInput.typeText("7");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("count=7"),
        "the mode's key to update the item",
      );
      // The host badge shares the row with the extension's item.
      expect(statusRow(setup.captureCharFrame())).toContain("Counting");

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("count="),
        "the mode exit to clear the item",
      );
    });
  });

  test("a malformed item throws from set instead of reaching the row", async () => {
    const repo = createTestRepo("hunk-status-bad-");
    const extDir = createTempDir("hunk-status-bad-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    try {\n` +
        `      ctx.statusLine.set({ id: "x", spans: "not an array" });\n` +
        `      log("no throw");\n` +
        `    } catch (error) {\n` +
        `      log("threw " + error.message);\n` +
        `    }\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      await pressY(setup);
      await flushUntil(
        setup,
        () => readProbeLog(logPath).length > 0,
        "the command handler to finish",
      );
      expect(readProbeLog(logPath)).toEqual([
        "threw statusLine.set requires spans to be an array.",
      ]);
      expect(setup.captureCharFrame()).not.toContain("not an array");
    });
  });

  test("replacing the extension registry clears the items it set", async () => {
    const repo = createTestRepo("hunk-status-registry-");
    const extDir = createTempDir("hunk-status-registry-ext-");
    const extPath = join(extDir, "ext.ts");
    // Sets its item exactly once per process, so the reload after the trust grant cannot
    // simply set it again: whatever is on the row afterwards survived the registry swap.
    writeFileSync(
      extPath,
      `export default function (hunk) {\n` +
        `  hunk.on("changeset_loaded", (_payload, ctx) => {\n` +
        `    if (globalThis.__hunkRegistryItemSet) return;\n` +
        `    globalThis.__hunkRegistryItemSet = true;\n` +
        `    ctx.statusLine.set({ id: "once", spans: [{ text: "set by first registry" }] });\n` +
        `  });\n` +
        `}\n`,
    );
    // A repo extension with no trust decision makes the trust prompt appear; granting it is
    // the one way to replace the registry mid-session.
    mkdirSync(join(repo, ".hunk", "extensions"), { recursive: true });
    writeFileSync(
      join(repo, ".hunk", "extensions", "local.ts"),
      `export default function (hunk) { hunk.log("loaded"); }\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    expect(bootstrap.extensions?.pendingTrustRepoRoot).toBeDefined();
    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("set by first registry"),
        "the first registry's item to render",
      );
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Run this repository's extensions?"),
        "the trust prompt to open",
      );

      await act(async () => {
        await setup.mockInput.typeText("t");
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return (
            !frame.includes("Run this repository's extensions?") &&
            frame.includes("alpha.txt") &&
            !frame.includes("set by first registry")
          );
        },
        "the replacement registry to clear the retired registry's item",
      );
    });
  });
});

describe("extension prompts", () => {
  test("a prompt renders inline with attribution and resolves the typed text on enter", async () => {
    const repo = createTestRepo("hunk-prompt-enter-");
    const extDir = createTempDir("hunk-prompt-enter-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    const answer = await ctx.prompts.line({ prefix: "/", placeholder: "pattern" });\n` +
        `    log("answer " + String(answer));\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup, quits) => {
      await openReview(setup);
      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ext ext / pattern"),
        "the attributed prompt to open with its placeholder",
      );

      // A bound key is text while the prompt owns typing: `q` must not quit.
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ext ext / q"),
        "the typed key to land in the input",
      );
      expect(quits()).toBe(0);

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer q"),
        "the handler to resolve the typed text",
      );
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("ext ext /"),
        "the prompt to close",
      );
    });
  });

  test("escape clears a non-empty buffer first and cancels with null second", async () => {
    const repo = createTestRepo("hunk-prompt-escape-");
    const extDir = createTempDir("hunk-prompt-escape-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    const answer = await ctx.prompts.line({ prefix: ":", initial: "wq" });\n` +
        `    log("answer " + String(answer));\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ext ext : wq"),
        "the prompt to open with its initial text",
      );

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => {
          const frame = setup.captureCharFrame();
          return frame.includes("ext ext :") && !frame.includes(": wq");
        },
        "the first escape to clear the buffer",
      );
      expect(readProbeLog(logPath)).toEqual([]);

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer null"),
        "the second escape to cancel",
      );
    });
  });

  test("a second prompt queues behind the first and reports live edits", async () => {
    const repo = createTestRepo("hunk-prompt-queue-");
    const extDir = createTempDir("hunk-prompt-queue-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    const first = ctx.prompts.line({ prefix: "first:", onChange: (value) => log("edit " + value) });\n` +
        `    const second = ctx.prompts.line({ prefix: "second:" });\n` +
        `    log("first " + String(await first));\n` +
        `    log("second " + String(await second));\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("first:"),
        "the first prompt to open",
      );
      expect(setup.captureCharFrame()).not.toContain("second:");

      await act(async () => {
        await setup.mockInput.typeText("ab");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("edit ab"),
        "onChange to report each edit",
      );
      expect(readProbeLog(logPath)).toEqual(["edit a", "edit ab"]);

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("second:"),
        "the queued prompt to be promoted",
      );
      await act(async () => {
        await setup.mockInput.typeText("z");
        await setup.mockInput.pressEnter();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("second z"),
        "the second prompt to resolve",
      );
      expect(readProbeLog(logPath)).toEqual(["edit a", "edit ab", "first ab", "second z"]);
    });
  });

  test("a daemon-driven session reload cancels the open prompt", async () => {
    const repo = createTestRepo("hunk-prompt-reload-");
    const extDir = createTempDir("hunk-prompt-reload-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    const answer = await ctx.prompts.line({ prefix: "/" });\n` +
        `    log("answer " + String(answer));\n`,
    );

    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await openReview(setup);
        await pressY(setup);
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("ext ext /"),
          "the prompt to open",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => {
            const frame = setup.captureCharFrame();
            return !frame.includes("ext ext /") && frame.includes("alpha.txt");
          },
          "the reload to close the prompt over the replacement review",
        );
        await reload;
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("answer null"),
          "the handler to resolve the cancel value",
        );
      },
      broker.client,
    );
  });

  test("a content reload preserves the host filter's value and keyboard focus", async () => {
    const repo = createTestRepo("hunk-filter-reload-");
    const extDir = createTempDir("hunk-filter-reload-ext-");
    const extPath = join(extDir, "ext.ts");
    writeFileSync(extPath, "export default function (hunk) {}\n");
    const broker = createTestBrokerClient();
    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(
      bootstrap,
      async (setup) => {
        await openReview(setup);
        await act(async () => {
          await setup.mockInput.pressTab();
          await setup.mockInput.typeText("beta");
        });
        await flushUntil(
          setup,
          () => statusRow(setup.captureCharFrame()).includes("filter: beta"),
          "the filter to open",
        );
        writeFileSync(join(repo, "beta.txt"), "one\ntwo\nreloaded\n");
        const reload = broker.reload({ kind: "vcs", staged: false, options: {} });
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("reloaded"),
          "the replacement content to render",
        );
        await reload;
        expect(statusRow(setup.captureCharFrame())).toContain("filter: beta");
        await act(async () => {
          await setup.mockInput.typeText(".txt");
        });
        await flushUntil(
          setup,
          () => statusRow(setup.captureCharFrame()).includes("filter: beta.txt"),
          "typing to remain in the filter",
        );
        expect(setup.captureCharFrame()).not.toContain("alpha.txt");
      },
      broker.client,
    );
  });

  test("the host filter still works beside an extension prompt", async () => {
    const repo = createTestRepo("hunk-prompt-filter-");
    const extDir = createTempDir("hunk-prompt-filter-ext-");
    const logPath = join(extDir, "probe.log");
    const extPath = join(extDir, "ext.ts");
    writeCommandFixture(
      extPath,
      logPath,
      `    const answer = await ctx.prompts.line({ prefix: "/" });\n` +
        `    log("answer " + String(answer));\n`,
    );

    const bootstrap = await launchWithExtension(repo, extPath);
    await withAppHost(bootstrap, async (setup) => {
      await openReview(setup);
      // Filter first: Tab opens the host prompt, typing narrows the review, Tab leaves it.
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("filter: type to filter files"),
        "the filter prompt to open",
      );
      await act(async () => {
        await setup.mockInput.typeText("beta");
      });
      await flushUntil(
        setup,
        () => !setup.captureCharFrame().includes("alpha.txt"),
        "the filter to narrow the review",
      );
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("filter=beta"),
        "the filter prompt to close and leave its residual item",
      );

      // The extension prompt takes the left region; the residual filter item hides meanwhile.
      await pressY(setup);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ext ext /"),
        "the extension prompt to open",
      );
      expect(setup.captureCharFrame()).not.toContain("filter=beta");
      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("answer null"),
        "the extension prompt to cancel",
      );
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("filter=beta"),
        "the residual filter item to return",
      );
    });
  });
});
