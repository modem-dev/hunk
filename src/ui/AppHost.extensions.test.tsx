import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput } from "../core/types";
import type { HunkSessionBrokerClient } from "../hunk-session/types";
import { applyExtensionRegistrations, resolveExtensionDetectedVcsId } from "../extensions/apply";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

/**
 * Extension behavior that only exists once a session is *running*.
 *
 * Everything here is about the difference between first launch and reload.
 * `prepareStartupPlan` is well covered on its own, but a live session reloads
 * through `AppHost.reloadSession`, and each case below is a way the two paths
 * had drifted apart — losing launch flags, skipping extension VCS detection,
 * never delivering `startup` to an extension loaded mid-session.
 *
 * Reloads are driven the way they really arrive — a daemon `reload_session`
 * command through the session bridge, or `t` on the trust prompt — rather than
 * by calling `reloadSession` directly. That distinction matters: the daemon
 * re-parses its command from scratch, so `nextInput` carries none of the launch
 * flags, which is precisely the condition these regressions need.
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

/** Create a Git checkout with a committed file, a working-tree change, and a subdirectory. */
function createTestRepo(prefix: string) {
  const repo = createTempDir(prefix);
  execSync("git init && git config user.email test@test && git config user.name test", {
    cwd: repo,
    stdio: "ignore",
  });
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "sub", "a.txt"), "one\n");
  execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "sub", "a.txt"), "one\ntwo\n");
  return repo;
}

/** Point global config resolution at a throwaway directory for one test. */
function useTempConfigHome(configToml?: string) {
  const configHome = createTempDir("hunk-apphost-xdg-");
  process.env.XDG_CONFIG_HOME = configHome;
  if (configToml !== undefined) {
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(join(configHome, "hunk", "config.toml"), configToml);
  }
  return configHome;
}

/** Write an extension that appends every lifecycle event it sees to a log file. */
function writeProbeExtension(path: string, logPath: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");\n` +
      `  hunk.on("startup", () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "startup\\n");\n` +
      `  });\n` +
      `  hunk.on("session_reload", () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "session_reload\\n");\n` +
      `  });\n` +
      `}\n`,
  );
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

/** Render frames until a condition holds, or the attempts run out. */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  attempts = 40,
) {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/**
 * A broker client stub that captures the bridge App registers with it.
 *
 * Daemon reloads are the case that matters here: `hunk session reload <id> -- diff`
 * re-parses its tokens from scratch, so `nextInput` carries none of the flags
 * the session was launched with. The interactive refresh key cannot stand in for
 * it — that path reuses the live bootstrap input and so never loses anything.
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
    reload: async (nextInput: CliInput, sourcePath?: string) => {
      if (!bridge) {
        throw new Error("App never registered a session bridge.");
      }

      return await bridge.dispatchCommand({
        type: "command",
        requestId: "test-request",
        command: "reload_session",
        input: { sessionId: "test-session", nextInput, sourcePath },
      });
    },
  };
}

/** Mount one AppHost, run the body against it, and always tear the renderer down. */
async function withAppHost(
  bootstrap: AppBootstrap,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
  hostClient?: HunkSessionBrokerClient,
) {
  const setup = await testRender(<AppHost bootstrap={bootstrap} hostClient={hostClient} />, {
    width: 120,
    height: 24,
  });

  try {
    await flush(setup);
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/**
 * Launch a session whose cwd is a subdirectory of the repo it reviews.
 *
 * Refreshing re-resolves the session against the repo root, so the reload moves
 * to a different working directory — which is exactly what makes it re-run
 * extension discovery, the way a daemon cross-directory reload does.
 */
async function launchInSubdirectory(repo: string, options: Record<string, unknown>) {
  return await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "stack", ...options } },
    { cwd: join(repo, "sub") },
  );
}

describe("reload keeps launch extension authority", () => {
  test("--no-extensions still disables extensions when a reload re-runs discovery", async () => {
    const repo = createTestRepo("hunk-apphost-noext-");
    const logPath = join(repo, "probe.log");
    const extPath = join(repo, "ext.ts");
    writeProbeExtension(extPath, logPath);
    // Configured globally rather than by flag, so the only thing keeping it from
    // loading on the reload is the launch's `--no-extensions`.
    useTempConfigHome(`[extensions]\npaths = [${JSON.stringify(extPath)}]\n`);

    const bootstrap = await launchInSubdirectory(repo, { extensions: false });
    const broker = createTestBrokerClient();

    await withAppHost(
      bootstrap,
      async (setup) => {
        expect(readProbeLog(logPath)).toEqual([]);

        // A daemon reload command, parsed fresh: it carries no extension flags.
        await broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(setup, () => false, 10);

        // The reload moved cwd and re-ran discovery; the hard off switch held.
        expect(readProbeLog(logPath)).toEqual([]);
      },
      broker.client,
    );
  });

  test("--extension paths survive a reload that re-runs discovery", async () => {
    const repo = createTestRepo("hunk-apphost-extpath-");
    const logPath = join(repo, "probe.log");
    const extPath = join(repo, "ext.ts");
    writeProbeExtension(extPath, logPath);
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });

    const broker = createTestBrokerClient();
    await withAppHost(
      bootstrap,
      async (setup) => {
        const beforeReload = readProbeLog(logPath).length;

        await broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(setup, () => readProbeLog(logPath).length > beforeReload);

        // The reload command carries no `--extension` flags of its own, so the
        // factory only runs again if the launch paths were re-threaded.
        expect(readProbeLog(logPath).filter((line) => line === "factory")).toHaveLength(2);
      },
      broker.client,
    );
  });
});

describe("startup for extensions loaded mid-session", () => {
  test("fires when granting trust loads a repo extension for the first time", async () => {
    const repo = createTestRepo("hunk-apphost-trust-");
    const logPath = join(repo, "probe.log");
    writeProbeExtension(join(repo, ".hunk", "extensions", "probe.ts"), logPath);
    // Trust decisions live in the global state file; keep this test off the
    // developer's real one.
    useTempConfigHome();

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "stack" } },
      { cwd: repo },
    );
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: repo,
    });
    // The repo extension is skipped pending a trust decision, so nothing ran.
    expect(bootstrap.extensions.pendingTrustRepoRoot).toBeDefined();
    expect(readProbeLog(logPath)).toEqual([]);

    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(setup, () =>
        setup.captureCharFrame().includes("Run this repository's extensions?"),
      );

      // Grant trust: records the decision and reloads with `reloadExtensions`.
      await act(async () => {
        await setup.mockInput.typeText("t");
      });
      await flushUntil(setup, () => readProbeLog(logPath).includes("session_reload"));

      const events = readProbeLog(logPath);
      expect(events).toContain("factory");
      // The whole point: an extension loaded after mount still gets `startup`.
      expect(events).toContain("startup");
      // Ordered before session_reload, so its lifecycle stays in sequence.
      expect(events.indexOf("startup")).toBeLessThan(events.indexOf("session_reload"));
    });
  });

  test("does not fire a second time for an extension that already had it", async () => {
    const repo = createTestRepo("hunk-apphost-startup-once-");
    const logPath = join(repo, "probe.log");
    const extPath = join(repo, "ext.ts");
    writeProbeExtension(extPath, logPath);
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });

    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(setup, () => readProbeLog(logPath).includes("startup"));
      expect(readProbeLog(logPath).filter((line) => line === "startup")).toHaveLength(1);

      await act(async () => {
        await setup.mockInput.typeText("r");
      });
      await flushUntil(setup, () => readProbeLog(logPath).includes("session_reload"));

      // The reload re-ran the factory, but `startup` is a once-per-extension
      // promise: this id already had it, so it is not delivered again.
      const events = readProbeLog(logPath);
      expect(events.filter((line) => line === "factory")).toHaveLength(2);
      expect(events.filter((line) => line === "startup")).toHaveLength(1);
    });
  });
});

describe("reload re-runs extension VCS detection", () => {
  test("an extension backend keeps a checkout no built-in recognizes", async () => {
    // A directory with only an `.hg` marker. No built-in backend detects it, so
    // config resolves `vcs` to the default Git backend on every pass — including
    // the reload, which is where the session used to silently change backends.
    const outer = createTempDir("hunk-apphost-vcs-");
    const repo = join(outer, "hgrepo");
    mkdirSync(join(repo, ".hg"), { recursive: true });
    writeFileSync(join(repo, "f.txt"), "one\n");
    useTempConfigHome();

    const extPath = join(outer, "hg-ext.ts");
    writeFileSync(
      extPath,
      `import { existsSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `export default function (hunk) {\n` +
        `  hunk.registerVcsAdapter({\n` +
        `    id: "hg",\n` +
        `    name: "Mercurial",\n` +
        `    detect: (cwd) => (existsSync(join(cwd, ".hg")) ? { id: "hg", repoRoot: cwd } : null),\n` +
        `    operations: {\n` +
        `      "working-tree-diff": {\n` +
        `        async load(input, ctx) {\n` +
        `          return {\n` +
        `            repoRoot: ctx.cwd,\n` +
        `            sourceLabel: ctx.cwd,\n` +
        `            title: "Mercurial working copy",\n` +
        `            patchText: "",\n` +
        `          };\n` +
        `        },\n` +
        `      },\n` +
        `    },\n` +
        `  });\n` +
        `}\n`,
    );

    const extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: repo,
      cliExtensionPaths: [extPath],
    });
    expect(extensions.issues).toEqual([]);
    const { vcsAdapters } = applyExtensionRegistrations(extensions);

    // Launch the way `prepareStartupPlan` does: extension detection claims the
    // checkout, and the changeset loads through the extension backend.
    const bootstrap = await loadAppBootstrap(
      {
        kind: "vcs",
        staged: false,
        options: {
          mode: "stack",
          extensionPaths: [extPath],
          vcs: resolveExtensionDetectedVcsId(repo, vcsAdapters),
        },
      },
      { cwd: repo, vcsAdapters },
    );
    bootstrap.extensions = extensions;
    expect(bootstrap.changeset.title).toBe("Mercurial working copy");

    const broker = createTestBrokerClient();
    await withAppHost(
      bootstrap,
      async (setup) => {
        // The reload command names no backend, and config resolves `vcs` to the
        // Git default for this directory, so only re-running extension detection
        // keeps the session on the backend that actually understands it.
        const result = (await broker.reload({ kind: "vcs", staged: false, options: {} }, repo)) as {
          title: string;
        };
        await flushUntil(setup, () => false, 10);

        expect(result.title).toBe("Mercurial working copy");
      },
      broker.client,
    );
  });
});
