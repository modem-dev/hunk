import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { resolveConfiguredCliInput } from "../core/config";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap } from "../core/types";
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
  const configured = resolveConfiguredCliInput(input, { cwd: repo });
  const bootstrap = await loadAppBootstrap(configured.input, { cwd: repo });
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
) {
  let quitCount = 0;
  const setup = await testRender(
    <AppHost bootstrap={bootstrap} onQuit={() => (quitCount += 1)} />,
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
    const bootstrap = await launchWithConfig(repo, '[keybindings]\n"app.quit" = "ctrl+x"\n');

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
      '[keybindings]\n"review.focusFilter" = ["q", "/"]\n',
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
    const bootstrap = await launchWithConfig(repo, '[keybindings]\n"app.quit" = false\n');

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
});
