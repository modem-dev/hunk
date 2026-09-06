import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { resolveConfiguredCliInput } from "../core/run/config";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { loadAppBootstrap } from "../core/changeset/loaders";
import type { AppBootstrap } from "../core/bootstrap";
import { retireExtensionLoadResult } from "../extensions/events";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { AppHost } from "./AppHost";

/**
 * User keybindings, end to end.
 *
 * The unit tests prove chord resolution; what only a running session can show
 * is that a `[keybindings]` table in the user's config actually reaches the
 * dispatch table — config read, threaded onto the bootstrap, resolved against
 * the command defaults, and matched against real terminal input.
 */

const tempDirs: string[] = [];
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTestDirectory(dir);
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Create a Git checkout with one committed file carrying a working-tree change. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(join(repo, "alpha.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "alpha.txt"), "one\ntwo\n");
  return repo;
}

/** Point global config resolution at a throwaway directory holding one config file. */
function useTempConfigHome(configToml: string) {
  const configHome = createTempDir("hunk-keybindings-xdg-");
  process.env.XDG_CONFIG_HOME = configHome;
  mkdirSync(join(configHome, "hunk"), { recursive: true });
  writeFileSync(join(configHome, "hunk", "config.toml"), configToml);
  return configHome;
}

/**
 * Launch a review of one repo with the given user config in force.
 *
 * The bootstrap takes its keybindings from real config resolution, the way
 * startup planning assembles it, so the test covers the config layer too.
 */
async function launchWithConfig(repo: string, configToml: string): Promise<AppBootstrap> {
  useTempConfigHome(configToml);
  const input = {
    kind: "vcs" as const,
    staged: false,
    options: { mode: "stack" as const, promptSaveViewPreferences: false },
  };
  const vcsCatalog = getBundledVcsCatalog();
  const configured = resolveConfiguredCliInput(input, { cwd: repo, vcsCatalog });
  const bootstrap = await loadAppBootstrap(configured.input, { cwd: repo, vcsCatalog });
  bootstrap.keybindings = configured.keybindings;
  return bootstrap;
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Mount one AppHost, run the body against it, and always tear the renderer down. */
async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>, quits: () => number) => Promise<void>,
  externalQuitSignal?: AbortSignal,
  extensionOwnership: "owned" | "borrowed" = "owned",
) {
  let quitCount = 0;
  const setup = await testRender(
    <AppHost
      bootstrap={bootstrap}
      externalQuitSignal={externalQuitSignal}
      onQuit={() => (quitCount += 1)}
      extensionOwnership={extensionOwnership}
    />,
    { width: 120, height: 24 },
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

describe("user keybindings", () => {
  test("a config table rebinds a built-in command and frees its old key", async () => {
    const repo = createTestRepo("hunk-keybindings-remap-");
    const bootstrap = await launchWithConfig(repo, '[keybindings]\n"hunk.app.quit" = "ctrl+x"\n');

    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      // The default chord was replaced, not added to.
      expect(quits()).toBe(0);

      await act(async () => {
        setup.mockInput.pressKey("x", { ctrl: true });
      });
      await flush(setup);
      expect(quits()).toBe(1);
    });
  });

  test("a user-bound chord is taken from the command that held it by default", async () => {
    const repo = createTestRepo("hunk-keybindings-claim-");
    // The filter key claims "q", which quit holds by default — and quit is
    // earlier in the dispatch table, so it would win if the claim did nothing.
    const bootstrap = await launchWithConfig(
      repo,
      '[keybindings]\n"hunk.review.focusFilter" = ["q", "/"]\n',
    );

    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      expect(quits()).toBe(0);
    });
  });

  test("unbinding leaves the key doing nothing", async () => {
    const repo = createTestRepo("hunk-keybindings-unbind-");
    const bootstrap = await launchWithConfig(repo, '[keybindings]\n"hunk.app.quit" = false\n');

    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      expect(quits()).toBe(0);
    });
  });

  test("with no keybindings config the shipped chords still apply", async () => {
    const repo = createTestRepo("hunk-keybindings-default-");
    const bootstrap = await launchWithConfig(repo, "");

    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      expect(quits()).toBe(1);
    });
  });

  test("a legacy command id remaps the canonical files-pane command", async () => {
    const repo = createTestRepo("hunk-keybindings-files-pane-alias-");
    const bootstrap = await launchWithConfig(
      repo,
      '[keybindings]\n"hunk.view.toggleSidebar" = "f6"\n',
    );
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.eventHandlers.command_executed.push({
      extensionId: "coach",
      handler: ({ commandId }) => {
        seen.push(commandId);
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);
      expect(seen).toEqual([]);

      await act(async () => {
        await setup.mockInput.pressKey("F6");
      });
      await flush(setup);
      expect(seen).toEqual(["hunk.view.toggleFilesPane"]);
    });
  });

  test("theme selector honors configured vertical review bindings", async () => {
    const repo = createTestRepo("hunk-keybindings-theme-selector-");
    const bootstrap = await launchWithConfig(
      repo,
      '[keybindings]\n"hunk.review.stepDown" = ["down", "j", "ctrl+n"]\n"hunk.review.stepUp" = ["up", "k", "ctrl+p"]\n',
    );

    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("t");
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Theme selector");

      await act(async () => {
        setup.mockInput.pressKey("n", { ctrl: true });
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("›  github-dark-dimmed");

      await act(async () => {
        setup.mockInput.pressKey("p", { ctrl: true });
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("›  github-dark-default");
    });
  });

  test("emits command_executed after keyboard dispatch", async () => {
    const repo = createTestRepo("hunk-keybindings-command-event-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.eventHandlers.command_executed.push({
      extensionId: "coach",
      handler: ({ commandId }) => {
        seen.push(commandId);
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      await flush(setup);
      expect(seen).toContain("hunk.review.stepDown");
    });
  });

  test("observes commands invoked through extension command controls exactly once", async () => {
    const repo = createTestRepo("hunk-keybindings-programmatic-command-event-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.commands.push({
      extensionId: "coach",
      command: { id: "toggle-lines", title: "Toggle lines", key: "y" },
      handler: (ctx) => {
        ctx.commands.execute("hunk.view.toggleLineNumbers");
      },
    });
    extensions.registry.eventHandlers.command_executed.push({
      extensionId: "coach",
      handler: ({ commandId }) => {
        seen.push(commandId);
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flush(setup);
      expect(seen).toEqual(["hunk.view.toggleLineNumbers", "coach.toggle-lines"]);
    });
  });

  test("observes quit before shutdown remains the terminal lifecycle event", async () => {
    const repo = createTestRepo("hunk-keybindings-quit-event-order-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.eventHandlers.command_executed.push({
      extensionId: "coach",
      handler: ({ commandId }) => {
        seen.push(`command:${commandId}`);
      },
    });
    extensions.registry.eventHandlers.shutdown.push({
      extensionId: "coach",
      handler: () => {
        seen.push("shutdown");
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(bootstrap, async (setup, quits) => {
      await act(async () => {
        await setup.mockInput.typeText("q");
      });
      await flush(setup);
      expect(seen).toEqual(["command:hunk.app.quit", "shutdown"]);
      expect(quits()).toBe(1);
    });
  });

  test("borrows one history extension authority across repeated review mounts", async () => {
    const repo = createTestRepo("hunk-keybindings-borrowed-extensions-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.eventHandlers.startup.push({
      extensionId: "stateful",
      handler: () => {
        seen.push("startup");
      },
    });
    extensions.registry.eventHandlers.changeset_loaded.push({
      extensionId: "stateful",
      handler: () => {
        seen.push("changeset");
      },
    });
    extensions.registry.eventHandlers.shutdown.push({
      extensionId: "stateful",
      handler: () => {
        seen.push("shutdown");
      },
    });
    bootstrap.extensions = extensions;

    for (let generation = 0; generation < 2; generation += 1) {
      await withAppHost(
        bootstrap,
        async (setup, quits) => {
          await act(async () => setup.mockInput.typeText("q"));
          await flush(setup);
          expect(quits()).toBe(1);
        },
        undefined,
        "borrowed",
      );
    }

    expect(seen).toEqual(["changeset", "changeset"]);
    await retireExtensionLoadResult(extensions);
    expect(seen).toEqual(["changeset", "changeset", "shutdown"]);
  });

  test("retires extensions before an external terminal interrupt quits", async () => {
    const repo = createTestRepo("hunk-keybindings-interrupt-shutdown-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const quitController = new AbortController();
    const seen: string[] = [];
    extensions.registry.eventHandlers.shutdown.push({
      extensionId: "coach",
      handler: () => {
        seen.push("shutdown");
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(
      bootstrap,
      async (setup, quits) => {
        await act(async () => quitController.abort());
        await flush(setup);
        expect(seen).toEqual(["shutdown"]);
        expect(quits()).toBe(1);
      },
      quitController.signal,
    );
  });

  test("emits command_executed when Tab leaves the focused file filter", async () => {
    const repo = createTestRepo("hunk-keybindings-focused-command-event-");
    const bootstrap = await launchWithConfig(repo, "");
    const extensions = createEmptyExtensionLoadResult(repo);
    const seen: string[] = [];
    extensions.registry.eventHandlers.command_executed.push({
      extensionId: "coach",
      handler: ({ commandId }) => {
        seen.push(commandId);
      },
    });
    bootstrap.extensions = extensions;

    await withAppHost(bootstrap, async (setup) => {
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      seen.length = 0;

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      expect(seen).toEqual(["hunk.app.toggleFocusArea"]);
    });
  });
});
