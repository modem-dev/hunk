import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../test/helpers/filesystem";
import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/loaders";
import type { CliInput } from "../core/types";

import type { HunkSessionBrokerClient } from "../session/types";
import {
  applyExtensionRegistrations,
  resolveDetectedVcsIdWithExtensions,
} from "../extensions/apply";
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

/** Turn one existing directory into a Git checkout with a committed file, a working-tree change, and a subdirectory. */
function initTestRepo(repo: string) {
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

/** Create a Git checkout with a committed file, a working-tree change, and a subdirectory. */
function createTestRepo(prefix: string) {
  return initTestRepo(createTempDir(prefix));
}

/**
 * Create a Git checkout reachable under a second, non-canonical path.
 *
 * Returns `undefined` where symlinks need privileges the environment lacks. The
 * alias stands in for every way a session is launched with a spelling of its
 * repo root that `realpathSync.native` would rewrite — a symlinked ancestor, or
 * a Windows 8.3 short path such as the `C:\Users\RUNNER~1\...` temp directory.
 */
function createAliasedTestRepo(prefix: string) {
  const outer = createTempDir(prefix);
  const canonicalRepo = join(outer, "repo");
  const aliasRepo = join(outer, "alias");
  mkdirSync(canonicalRepo, { recursive: true });

  try {
    symlinkSync(canonicalRepo, aliasRepo, "dir");
  } catch {
    // Some Windows environments cannot create symlinks without elevated privileges.
    return undefined;
  }

  initTestRepo(canonicalRepo);
  return aliasRepo;
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

/** Render a fixed number of frames to let pending work settle. */
async function pumpFrames(setup: Awaited<ReturnType<typeof testRender>>, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    await flush(setup);
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}

/**
 * Render frames until a condition holds, and fail loudly when it never does.
 *
 * Giving up quietly turns "the thing never happened" into a confusing assertion
 * about whatever the test looked at next — an empty log, a blank frame — with
 * no hint that the wait itself expired. The budget is wall-clock rather than a
 * frame count because the work being waited on (a reload's directory scans,
 * dynamic import, and TypeScript transpile) is far slower on a cold CI runner
 * than locally — and it stays under Bun's 5s per-test timeout so the failure is
 * this message rather than a killed test.
 */
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
        await pumpFrames(setup, 10);

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
        await flushUntil(
          setup,
          () => readProbeLog(logPath).length > beforeReload,
          "the reload to run the extension factory again",
        );

        // The reload command carries no `--extension` flags of its own, so the
        // factory only runs again if the launch paths were re-threaded.
        expect(readProbeLog(logPath).filter((line) => line === "factory")).toHaveLength(2);
      },
      broker.client,
    );
  });
});

describe("file_viewed events", () => {
  test("fires again when a soft reload replaces the selected file with the same id", async () => {
    const repo = createTestRepo("hunk-apphost-file-viewed-");
    const logPath = join(repo, "file-viewed.log");
    const extPath = join(repo, "file-viewed.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";
export default function (hunk) {
  hunk.on("file_viewed", ({ file }) => appendFileSync(${JSON.stringify(logPath)}, file.id + "\\n"));
}
`,
    );
    useTempConfigHome();

    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "stack", extensionPaths: [extPath] } },
      { cwd: repo },
    );
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: repo,
      cliExtensionPaths: [extPath],
    });

    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => readProbeLog(logPath).length === 1,
        "the initial selected file to be reported",
      );

      // `r` requests a soft reload (`resetApp: false`), retaining selection and
      // its stable id while replacing the underlying review file object.
      await act(async () => {
        await setup.mockInput.typeText("r");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).length === 2,
        "the reloaded selected file to be reported",
      );

      const viewedIds = readProbeLog(logPath);
      expect(viewedIds[1]).toBe(viewedIds[0]);
    });
  });
});

/**
 * Answer a repo-extension trust prompt with `t` and return what the extension logged.
 *
 * Launching with a repo-local extension and no recorded decision is the only way
 * to reach the mid-session load path: nothing runs until the prompt is answered,
 * and answering it records the decision and reloads with `reloadExtensions`.
 */
async function grantTrustAndCollectProbeEvents(repo: string) {
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

  let events: string[] = [];
  await withAppHost(bootstrap, async (setup) => {
    // The prompt has to be on screen before `t` is typed, or the key reaches
    // the normal app handler and the trust question is never answered.
    await flushUntil(
      setup,
      () => setup.captureCharFrame().includes("Run this repository's extensions?"),
      "the repo-extension trust prompt to open",
    );

    // Grant trust: records the decision and reloads with `reloadExtensions`.
    await act(async () => {
      await setup.mockInput.typeText("t");
    });
    await flushUntil(
      setup,
      () => readProbeLog(logPath).includes("session_reload"),
      "the trusted repo extension to load and see the reload",
    );

    events = readProbeLog(logPath);
  });

  return events;
}

describe("startup for extensions loaded mid-session", () => {
  test("fires when granting trust loads a repo extension for the first time", async () => {
    const events = await grantTrustAndCollectProbeEvents(createTestRepo("hunk-apphost-trust-"));

    expect(events).toContain("factory");
    // The whole point: an extension loaded after mount still gets `startup`.
    expect(events).toContain("startup");
    // Ordered before session_reload, so its lifecycle stays in sequence.
    expect(events.indexOf("startup")).toBeLessThan(events.indexOf("session_reload"));
  });

  test("fires when the session was launched through a non-canonical repo path", async () => {
    const repo = createAliasedTestRepo("hunk-apphost-trust-alias-");
    if (!repo) {
      return;
    }

    // The grant records the root discovery reported, while the reload asks about
    // the canonicalized cwd. Unless those name one repository, the freshly
    // trusted extension is skipped all over again and nothing is ever logged.
    const events = await grantTrustAndCollectProbeEvents(repo);

    expect(events).toContain("factory");
    expect(events).toContain("startup");
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
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("startup"),
        "the launch extension to receive startup",
      );
      expect(readProbeLog(logPath).filter((line) => line === "startup")).toHaveLength(1);

      await act(async () => {
        await setup.mockInput.typeText("r");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("session_reload"),
        "the refresh key to reload the session",
      );

      // The reload re-ran the factory, but `startup` is a once-per-extension
      // promise: this id already had it, so it is not delivered again.
      const events = readProbeLog(logPath);
      expect(events.filter((line) => line === "factory")).toHaveLength(2);
      expect(events.filter((line) => line === "startup")).toHaveLength(1);
    });
  });
});

/**
 * Write a Mercurial-shaped extension backend that walks upward for `.hg`.
 *
 * Detection distance is what these tests are about, so the fixture reports a
 * real repo root rather than claiming whatever directory it is handed.
 */
function writeHgExtension(extPath: string) {
  writeFileSync(
    extPath,
    `import { existsSync } from "node:fs";\n` +
      `import { dirname, join, resolve } from "node:path";\n` +
      `function findHgRoot(cwd) {\n` +
      `  let current = resolve(cwd);\n` +
      `  for (;;) {\n` +
      `    if (existsSync(join(current, ".hg"))) return current;\n` +
      `    const parent = dirname(current);\n` +
      `    if (parent === current) return undefined;\n` +
      `    current = parent;\n` +
      `  }\n` +
      `}\n` +
      `export default function (hunk) {\n` +
      `  hunk.registerVcsAdapter({\n` +
      `    id: "hg",\n` +
      `    name: "Mercurial",\n` +
      `    detect: (cwd) => {\n` +
      `      const root = findHgRoot(cwd);\n` +
      `      return root ? { id: "hg", repoRoot: root } : null;\n` +
      `    },\n` +
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
}

describe("reload re-runs extension VCS detection", () => {
  const baseVcsCatalog = getBundledVcsCatalog();
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
    writeHgExtension(extPath);

    const extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: repo,
      cliExtensionPaths: [extPath],
    });
    expect(extensions.issues).toEqual([]);
    const { vcsCatalog } = applyExtensionRegistrations(extensions, baseVcsCatalog);

    // Launch the way `prepareStartupPlan` does: extension detection claims the
    // checkout, and the changeset loads through the extension backend.
    const bootstrap = await loadAppBootstrap(
      {
        kind: "vcs",
        staged: false,
        options: {
          mode: "stack",
          extensionPaths: [extPath],
          vcs: resolveDetectedVcsIdWithExtensions(repo, vcsCatalog),
        },
      },
      { cwd: repo, vcsCatalog },
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
        await pumpFrames(setup, 10);

        expect(result.title).toBe("Mercurial working copy");
      },
      broker.client,
    );
  });

  test("a nearer extension checkout inside a Git repository survives reload", async () => {
    // The nested shape: `.hg` one level inside a Git repository. Built-in-only
    // detection finds the outer Git root, so a reload that did not re-run
    // detection over the full adapter list would review the wrong repository —
    // and it has to reach the same answer first launch does.
    const repo = createTempDir("hunk-apphost-nested-vcs-");
    execSync("git init && git config user.email test@test && git config user.name test", {
      cwd: repo,
      stdio: "ignore",
    });
    const inner = join(repo, "inner-hg");
    mkdirSync(join(inner, ".hg"), { recursive: true });
    writeFileSync(join(inner, "f.txt"), "one\n");
    useTempConfigHome();

    const extPath = join(repo, "hg-ext.ts");
    writeHgExtension(extPath);

    const extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: inner,
      cliExtensionPaths: [extPath],
    });
    expect(extensions.issues).toEqual([]);
    const { vcsCatalog } = applyExtensionRegistrations(extensions, baseVcsCatalog);

    // First launch: the nearer `.hg` root wins over the outer Git root.
    expect(resolveDetectedVcsIdWithExtensions(inner, vcsCatalog)).toBe("hg");
    const bootstrap = await loadAppBootstrap(
      {
        kind: "vcs",
        staged: false,
        options: {
          mode: "stack",
          extensionPaths: [extPath],
          vcs: resolveDetectedVcsIdWithExtensions(inner, vcsCatalog),
        },
      },
      { cwd: inner, vcsCatalog },
    );
    bootstrap.extensions = extensions;
    expect(bootstrap.changeset.title).toBe("Mercurial working copy");

    const broker = createTestBrokerClient();
    await withAppHost(
      bootstrap,
      async (setup) => {
        const result = (await broker.reload(
          { kind: "vcs", staged: false, options: {} },
          inner,
        )) as {
          title: string;
        };
        await pumpFrames(setup, 10);

        expect(result.title).toBe("Mercurial working copy");
      },
      broker.client,
    );
  });
});
