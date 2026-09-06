import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { ReviewProducer } from "../app/review/producer";
import type { AppBootstrap } from "../app/types";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import { loadAppBootstrap as loadCoreAppBootstrap } from "../core/changeset/loaders";
import { fileLanguageForPath } from "../core/changeset/fileLanguageLookup";
import type { CliInput } from "../core/run/commandInputs";

import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import {
  applyExtensionRegistrations,
  resolveDetectedVcsIdWithExtensions,
} from "../extensions/apply";
import { loadStartupExtensions } from "../extensions/startup";
import { emitExtensionCustomEvent } from "../extensions/events";
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
function writeProbeExtension(path: string, logPath: string, languageExtension?: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      (languageExtension
        ? `  hunk.registerFileLanguage(${JSON.stringify(languageExtension)}, "python");\n`
        : "") +
      `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");\n` +
      `  hunk.on("startup", () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "startup\\n");\n` +
      `  });\n` +
      `  hunk.on("session_reload", () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "session_reload\\n");\n` +
      `  });\n` +
      `  hunk.on("shutdown", () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n");\n` +
      `  });\n` +
      `}\n`,
  );
}

/** Write an extension that records the settled result of one startup reload request. */
function writeStartupReloadResultExtension(path: string, logPath: string) {
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  hunk.on("startup", async (_event, ctx) => {\n` +
      `    const result = await ctx.review.requestReload();\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, result.ok ? "ok\\n" : result.reason + ":" + result.detail + "\\n");\n` +
      `  });\n` +
      `}\n`,
  );
}

/** Write a probe whose replacement transform waits until the test releases its commit gate. */
function writeDelayedReplacementExtension(path: string, logPath: string, releasePath: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync, existsSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  const replacement = existsSync(${JSON.stringify(logPath)});\n` +
      `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");\n` +
      `  hunk.transformChangeset(async (changeset) => {\n` +
      `    while (replacement && !existsSync(${JSON.stringify(releasePath)})) {\n` +
      `      await new Promise((resolve) => setTimeout(resolve, 10));\n` +
      `    }\n` +
      `    return changeset;\n` +
      `  });\n` +
      `  hunk.on("startup", () => appendFileSync(${JSON.stringify(logPath)}, "startup\\n"));\n` +
      `  hunk.on("session_reload", () => appendFileSync(${JSON.stringify(logPath)}, "session_reload\\n"));\n` +
      `  hunk.on("shutdown", () => appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n"));\n` +
      `}\n`,
  );
}

/** Write a probe whose replacement factory waits after registering its shutdown hook. */
function writeDelayedFactoryExtension(path: string, logPath: string, releasePath: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync, existsSync } from "node:fs";\n` +
      `export default async function (hunk) {\n` +
      `  const replacement = existsSync(${JSON.stringify(logPath)});\n` +
      `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");\n` +
      `  hunk.on("startup", () => appendFileSync(${JSON.stringify(logPath)}, "startup\\n"));\n` +
      `  hunk.on("shutdown", () => appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n"));\n` +
      `  while (replacement && !existsSync(${JSON.stringify(releasePath)})) {\n` +
      `    await new Promise((resolve) => setTimeout(resolve, 10));\n` +
      `  }\n` +
      `}\n`,
  );
}

/** Write a probe whose original instance holds shutdown until the test releases it. */
function writeDelayedOriginalShutdownExtension(path: string, logPath: string, releasePath: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync, existsSync } from "node:fs";\n` +
      `export default function (hunk) {\n` +
      `  const replacement = existsSync(${JSON.stringify(logPath)});\n` +
      `  const instance = replacement ? "replacement" : "original";\n` +
      `  appendFileSync(${JSON.stringify(logPath)}, "factory:" + instance + "\\n");\n` +
      `  hunk.on("startup", () => appendFileSync(${JSON.stringify(logPath)}, "startup:" + instance + "\\n"));\n` +
      `  hunk.on("shutdown", async () => {\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "shutdown:start:" + instance + "\\n");\n` +
      `    while (!replacement && !existsSync(${JSON.stringify(releasePath)})) {\n` +
      `      await new Promise((resolve) => setTimeout(resolve, 5));\n` +
      `    }\n` +
      `    appendFileSync(${JSON.stringify(logPath)}, "shutdown:end:" + instance + "\\n");\n` +
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
function createTestBrokerClient(options: { replaceSessionError?: Error } = {}) {
  let bridge: { dispatchCommand: (message: unknown) => Promise<unknown> } | null = null;
  let registration = { sessionId: "test-session" };
  let replacementCount = 0;

  const client = {
    setBridge(next: typeof bridge) {
      bridge = next;
    },
    getRegistration() {
      return registration;
    },
    replaceSession(nextRegistration: typeof registration) {
      replacementCount += 1;
      if (options.replaceSessionError) throw options.replaceSessionError;
      registration = nextRegistration;
    },
    updateSnapshot() {},
    updateRegistration() {},
    close() {},
  } as unknown as HunkSessionBrokerClient;

  return {
    client,
    registrationId: () => registration.sessionId,
    replacementCount: () => replacementCount,
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
  options: {
    externalQuitSignal?: AbortSignal;
    onQuit?: () => void;
    reviewProducer?: ReviewProducer;
    width?: number;
  } = {},
) {
  const setup = await testRender(
    <AppHost
      bootstrap={bootstrap}
      externalQuitSignal={options.externalQuitSignal}
      hostClient={hostClient}
      onQuit={options.onQuit}
      reviewProducer={options.reviewProducer}
    />,
    {
      width: options.width ?? 120,
      height: 24,
    },
  );

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

  test("a failed replacement keeps the visible extension instance running", async () => {
    const repo = createTestRepo("hunk-apphost-failed-extension-reload-");
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
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        await expect(
          broker.reload({ kind: "vcs", staged: false, range: "missing-ref", options: {} }, repo),
        ).rejects.toThrow("could not resolve Git revision or range");
        await pumpFrames(setup, 5);

        const events = readProbeLog(logPath);
        expect(events.filter((line) => line === "factory")).toHaveLength(2);
        expect(events.filter((line) => line === "shutdown")).toHaveLength(1);
        // The failed replacement is cleaned up after its factory runs; the
        // original instance was not shut down before the replacement proved valid.
        expect(events.indexOf("shutdown")).toBeGreaterThan(events.lastIndexOf("factory"));
        expect(events.filter((line) => line === "startup")).toHaveLength(1);
      },
      broker.client,
    );
  });

  test("a reloaded files replacement does not take toggle control from the open fallback", async () => {
    const repo = createTestRepo("hunk-apphost-sidebar-fallback-reload-");
    const logPath = join(repo, "probe.log");
    const extPath = join(repo, "ext.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");\n` +
        `  hunk.registerSidebarView({\n` +
        `    id: "broken",\n` +
        `    replacesDefault: true,\n` +
        `    component: () => { throw new Error("sidebar exploded"); },\n` +
        `  });\n` +
        `}\n`,
    );
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
        await flushUntil(
          setup,
          () => (setup.captureCharFrame().match(/a\.txt/g) ?? []).length === 2,
          "the built-in fallback to replace the crashed pane",
        );

        await broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "factory").length === 2,
          "the replacement extension to register again",
        );

        await act(async () => {
          await setup.mockInput.typeText("s");
        });
        await flushUntil(
          setup,
          () => (setup.captureCharFrame().match(/a\.txt/g) ?? []).length === 1,
          "the s key to close the visible built-in fallback",
        );
      },
      broker.client,
      { width: 240 },
    );
  });

  test("retires a prepared replacement when broker commit preparation throws", async () => {
    const repo = createTestRepo("hunk-apphost-broker-replacement-failure-");
    const logPath = join(repo, "probe.log");
    const extPath = join(repo, "ext.ts");
    writeProbeExtension(extPath, logPath, "currenthunksyntax");
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });
    applyExtensionRegistrations(bootstrap.extensions, getBundledVcsCatalog());
    const broker = createTestBrokerClient({ replaceSessionError: new Error("broker exploded") });
    const producer = new ReviewProducer(
      {
        files: bootstrap.changeset.files,
        sourceLabel: bootstrap.changeset.sourceLabel,
      },
      { producerId: "broker-failure" },
    );
    const initialGeneration = producer.getPublication().generation;
    expect(fileLanguageForPath("example.currenthunksyntax")).toBe("python");
    writeProbeExtension(extPath, logPath, "replacementhunksyntax");

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        await expect(
          broker.reload({ kind: "vcs", staged: false, options: {} }, repo),
        ).rejects.toThrow("broker exploded");
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "shutdown").length === 1,
          "the prepared replacement to retire after broker failure",
        );

        const events = readProbeLog(logPath);
        expect(producer.getPublication().generation).toBe(initialGeneration);
        expect(broker.registrationId()).toBe("test-session");
        expect(broker.replacementCount()).toBe(1);
        expect(events.filter((line) => line === "factory")).toHaveLength(2);
        expect(events.filter((line) => line === "startup")).toHaveLength(1);
        expect(events.filter((line) => line === "shutdown")).toHaveLength(1);
        expect(fileLanguageForPath("example.currenthunksyntax")).toBe("python");
        expect(fileLanguageForPath("example.replacementhunksyntax")).toBe("text");
      },
      broker.client,
      { reviewProducer: producer },
    );
  });

  test("refuses a queued replacement reload after quit becomes terminal", async () => {
    const repo = createTestRepo("hunk-apphost-queued-reload-quit-");
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
    const quitController = new AbortController();
    let quits = 0;

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        quitController.abort();

        await expect(reload).rejects.toThrow("shutting down");
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "shutdown").length === 1,
          "quit to retire the original extension",
        );
        expect(quits).toBe(1);
        expect(broker.replacementCount()).toBe(0);
        expect(readProbeLog(logPath).filter((line) => line === "factory")).toHaveLength(1);
      },
      broker.client,
      { externalQuitSignal: quitController.signal, onQuit: () => (quits += 1) },
    );
  });

  test("owns and retires a replacement still inside its asynchronous factory", async () => {
    const repo = createTestRepo("hunk-apphost-factory-reload-quit-");
    const logPath = join(repo, "probe.log");
    const releasePath = join(repo, "release-factory");
    const extPath = join(repo, "ext.ts");
    writeDelayedFactoryExtension(extPath, logPath, releasePath);
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });
    const broker = createTestBrokerClient();
    const quitController = new AbortController();
    let quits = 0;

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "factory").length === 2,
          "the replacement factory to suspend",
        );

        quitController.abort();
        await flushUntil(
          setup,
          () =>
            readProbeLog(logPath).filter((line) => line === "shutdown").length === 2 && quits === 1,
          "quit to retire provisional factory authority before process teardown",
        );
        expect(existsSync(releasePath)).toBe(false);

        writeFileSync(releasePath, "continue\n");
        await expect(reload).rejects.toThrow("shutting down");
        expect(broker.replacementCount()).toBe(0);
        expect(readProbeLog(logPath).filter((line) => line === "startup")).toHaveLength(1);
      },
      broker.client,
      { externalQuitSignal: quitController.signal, onQuit: () => (quits += 1) },
    );
  });

  test("retires an in-flight replacement instead of adopting it after quit", async () => {
    const repo = createTestRepo("hunk-apphost-inflight-reload-quit-");
    const logPath = join(repo, "probe.log");
    const releasePath = join(repo, "release-replacement");
    const extPath = join(repo, "ext.ts");
    writeDelayedReplacementExtension(extPath, logPath, releasePath);
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });
    const broker = createTestBrokerClient();
    const quitController = new AbortController();
    let quits = 0;

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "factory").length === 2,
          "the replacement to wait inside session loading",
        );
        expect(existsSync(releasePath)).toBe(false);

        quitController.abort();
        await flushUntil(
          setup,
          () =>
            readProbeLog(logPath).filter((line) => line === "shutdown").length === 2 && quits === 1,
          "quit to retire both runtimes before process teardown",
        );
        // The host can now exit even though session loading has not returned;
        // release it only so this test process can observe the rejected reload.
        expect(existsSync(releasePath)).toBe(false);
        writeFileSync(releasePath, "continue\n");
        await expect(reload).rejects.toThrow("shutting down");

        const events = readProbeLog(logPath);
        expect(quits).toBe(1);
        expect(broker.replacementCount()).toBe(0);
        expect(events.filter((line) => line === "startup")).toHaveLength(1);
        expect(events.filter((line) => line === "session_reload")).toHaveLength(0);
      },
      broker.client,
      { externalQuitSignal: quitController.signal, onQuit: () => (quits += 1) },
    );
  });

  test("waits for an adopted runtime's in-flight retirement before quit", async () => {
    const repo = createTestRepo("hunk-apphost-retirement-reload-quit-");
    const logPath = join(repo, "probe.log");
    const releasePath = join(repo, "release-shutdown");
    const extPath = join(repo, "ext.ts");
    writeDelayedOriginalShutdownExtension(extPath, logPath, releasePath);
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });
    const broker = createTestBrokerClient();
    const quitController = new AbortController();
    let quits = 0;

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup:original"),
          "the original extension instance to start",
        );

        const reload = broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("shutdown:start:original"),
          "the original runtime retirement to suspend",
        );

        quitController.abort();
        await pumpFrames(setup, 1);
        expect(quits).toBe(0);
        expect(readProbeLog(logPath)).not.toContain("shutdown:end:original");

        writeFileSync(releasePath, "continue\n");
        await reload;
        await flushUntil(
          setup,
          () => quits === 1,
          "quit to wait for the adopted runtime's prior retirement",
        );

        const events = readProbeLog(logPath);
        expect(events).toContain("shutdown:end:original");
        expect(events).toContain("shutdown:end:replacement");
      },
      broker.client,
      { externalQuitSignal: quitController.signal, onQuit: () => (quits += 1) },
    );
  });

  test("serializes concurrent reloads so every replacement receives a full lifecycle", async () => {
    const repo = createTestRepo("hunk-apphost-concurrent-extension-reload-");
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
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("startup"),
          "the original extension instance to start",
        );

        const first = broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        const second = broker.reload(
          { kind: "vcs", staged: false, options: {} },
          join(repo, "sub"),
        );
        await Promise.all([first, second]);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).filter((line) => line === "startup").length === 3,
          "both serialized replacement instances to start",
        );

        const events = readProbeLog(logPath);
        expect(events.filter((line) => line === "factory")).toHaveLength(3);
        expect(events.filter((line) => line === "shutdown")).toHaveLength(2);
        expect(events.filter((line) => line === "startup")).toHaveLength(3);
        expect(events.filter((line) => line === "session_reload")).toHaveLength(2);
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

describe("mounted lifecycle ordering", () => {
  test("reports unavailable when the mounted review cannot reload its input", async () => {
    const root = createTempDir("hunk-apphost-extension-unavailable-reload-");
    const logPath = join(root, "extension-reload.log");
    const extPath = join(root, "extension-reload.ts");
    writeStartupReloadResultExtension(extPath, logPath);
    useTempConfigHome();

    const bootstrap = await loadAppBootstrap(
      {
        kind: "patch",
        text: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n",
        options: { mode: "stack", extensionPaths: [extPath] },
      },
      { cwd: root },
    );
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: root,
      cliExtensionPaths: [extPath],
    });

    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(setup, () => existsSync(logPath), "the unavailable reload result");
      expect(readProbeLog(logPath)).toEqual([
        "unavailable:The current review cannot be reloaded from its original input.",
      ]);
    });
  });

  test("reports failed when a started extension reload cannot commit", async () => {
    const repo = createTestRepo("hunk-apphost-extension-failed-reload-");
    const logPath = join(repo, "extension-reload.log");
    const extPath = join(repo, "extension-reload.ts");
    writeStartupReloadResultExtension(extPath, logPath);
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
    const broker = createTestBrokerClient({ replaceSessionError: new Error("broker exploded") });

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(setup, () => existsSync(logPath), "the failed reload result");
        expect(readProbeLog(logPath)).toEqual([
          "failed:Failed to reload the current review: broker exploded",
        ]);
      },
      broker.client,
    );
  });

  test("delivers same-runtime reload events after the new review commits", async () => {
    const repo = createTestRepo("hunk-apphost-lifecycle-order-");
    const logPath = join(repo, "lifecycle.log");
    const extPath = join(repo, "lifecycle.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
        `  hunk.on("startup", () => log("lifecycle:startup"));\n` +
        `  hunk.on("changeset_loaded", () => log("lifecycle:changeset_loaded"));\n` +
        `  hunk.on("session_reload", ({ changeset }, ctx) => {\n` +
        `    log("lifecycle:session_reload");\n` +
        `    const added = changeset.files.find((file) => file.path === "gamma.txt");\n` +
        `    if (added) ctx.navigation.selectFile(added.id);\n` +
        `  });\n` +
        `  hunk.on("file_viewed", ({ file }) => log("viewed:" + file.path));\n` +
        `}\n`,
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
    expect(bootstrap.extensions.issues).toEqual([]);
    const broker = createTestBrokerClient();

    await withAppHost(
      bootstrap,
      async (setup) => {
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("lifecycle:changeset_loaded"),
          "the initial mounted lifecycle",
        );
        expect(readProbeLog(logPath).slice(0, 2)).toEqual([
          "lifecycle:startup",
          "lifecycle:changeset_loaded",
        ]);

        writeFileSync(join(repo, "gamma.txt"), "new file\n");
        await broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("viewed:gamma.txt"),
          "the committed review to accept lifecycle navigation",
        );

        expect(readProbeLog(logPath).filter((line) => line.startsWith("lifecycle:"))).toEqual([
          "lifecycle:startup",
          "lifecycle:changeset_loaded",
          "lifecycle:changeset_loaded",
          "lifecycle:session_reload",
        ]);
      },
      broker.client,
    );
  });

  test("lets a custom extension event reload externally changed review input", async () => {
    const repo = createTestRepo("hunk-apphost-extension-request-reload-");
    const reviewedPath = join(repo, "sub", "a.txt");
    const logPath = join(repo, "extension-reload.log");
    const extPath = join(repo, "extension-reload.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync, writeFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
        `  let retainedReview;\n` +
        `  let successorRequested = false;\n` +
        `  hunk.events.on("reload-probe:changed", async (_payload, ctx) => {\n` +
        `    retainedReview = ctx.review;\n` +
        `    const first = ctx.review.requestReload();\n` +
        `    const second = ctx.review.requestReload();\n` +
        `    log("coalesced:" + String(first === second));\n` +
        `    const result = await first;\n` +
        `    log(result.ok ? "result:ok" : "result:" + result.reason);\n` +
        `  });\n` +
        `  hunk.on("startup", () => {\n` +
        `    writeFileSync(${JSON.stringify(reviewedPath)}, "one\\ntwo\\nthree\\n");\n` +
        `    hunk.events.emit("reload-probe:changed", {});\n` +
        `  });\n` +
        `  hunk.on("session_reload", async ({ reason }, ctx) => {\n` +
        `    log("reload:" + reason);\n` +
        `    if (reason !== "extension" || successorRequested) return;\n` +
        `    successorRequested = true;\n` +
        `    const stale = await retainedReview.requestReload();\n` +
        `    log(stale.ok ? "stale:ok" : "stale:" + stale.reason);\n` +
        `    writeFileSync(${JSON.stringify(reviewedPath)}, "one\\ntwo\\nthree\\nfour\\n");\n` +
        `    const trailing = await ctx.review.requestReload();\n` +
        `    log(trailing.ok ? "trailing:ok" : "trailing:" + trailing.reason);\n` +
        `  });\n` +
        `}\n`,
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
        () => readProbeLog(logPath).includes("trailing:ok"),
        "the successor extension reload to commit",
      );

      const events = readProbeLog(logPath);
      expect(events).toContain("coalesced:true");
      expect(events).toContain("stale:unavailable");
      expect(events).toContain("result:ok");
      expect(events).toContain("trailing:ok");
      expect(events.filter((event) => event === "reload:extension")).toHaveLength(2);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("four"),
        "the successor extension reload frame to render",
      );
    });
  });

  test("reloads the review current when a queued extension request begins", async () => {
    const repo = createTestRepo("hunk-apphost-extension-current-reload-");
    const stagedPath = join(repo, "staged.txt");
    writeFileSync(stagedPath, "before\n");
    execSync("git add staged.txt", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m staged-base", { cwd: repo, stdio: "ignore" });
    writeFileSync(stagedPath, "before\nafter\n");
    execSync("git add staged.txt", { cwd: repo, stdio: "ignore" });

    const logPath = join(repo, "extension-current-reload.log");
    const extPath = join(repo, "extension-current-reload.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `export default function (hunk) {\n` +
        `  const log = (line) => appendFileSync(${JSON.stringify(logPath)}, line + "\\n");\n` +
        `  hunk.events.on("reload-probe:queued", async (_payload, ctx) => {\n` +
        `    const result = await ctx.review.requestReload();\n` +
        `    log(result.ok ? "result:ok" : "result:" + result.reason);\n` +
        `  });\n` +
        `  hunk.on("session_reload", ({ reason }) => log("reload:" + reason));\n` +
        `}\n`,
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
    const broker = createTestBrokerClient();

    await withAppHost(
      bootstrap,
      async (setup) => {
        const daemonReload = broker.reload({ kind: "vcs", staged: true, options: {} }, repo);
        emitExtensionCustomEvent(bootstrap.extensions!, "reload-probe:queued", {});
        await flushUntil(
          setup,
          () => readProbeLog(logPath).includes("result:ok"),
          "the queued extension reload to settle",
        );
        await daemonReload;

        expect(readProbeLog(logPath)).toEqual(["reload:daemon", "reload:extension", "result:ok"]);
        const frame = setup.captureCharFrame();
        expect(frame).toContain("staged.txt");
        expect(frame).not.toContain("a.txt");
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

  test("starts a replacement only after its mounted sidebar controls are ready", async () => {
    const repo = createTestRepo("hunk-apphost-mounted-startup-");
    const logPath = join(repo, "mounted.log");
    const extPath = join(repo, "mounted.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";
` +
        `import { createElement } from "react";
` +
        `export default function (hunk) {
` +
        `  appendFileSync(${JSON.stringify(logPath)}, "factory\\n");
` +
        `  hunk.registerSidebarView({
` +
        `    id: "probe",
` +
        `    title: "Probe",
` +
        `    component: () => createElement("text", { content: "MOUNTED STARTUP SIDEBAR" }),
` +
        `  });
` +
        `  hunk.on("startup", (_payload, ctx) => {
` +
        `    ctx.sidebars.open("probe");
` +
        `    appendFileSync(${JSON.stringify(logPath)}, "startup\\n");
` +
        `  });
` +
        `  hunk.on("shutdown", () => appendFileSync(${JSON.stringify(logPath)}, "shutdown\\n"));
` +
        `}
`,
    );
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
        await flushUntil(
          setup,
          () => setup.captureCharFrame().includes("MOUNTED STARTUP SIDEBAR"),
          "the initial startup handler to open its mounted sidebar",
        );

        await broker.reload({ kind: "vcs", staged: false, options: {} }, repo);
        await flushUntil(
          setup,
          () =>
            readProbeLog(logPath).filter((line) => line === "startup").length === 2 &&
            setup.captureCharFrame().includes("MOUNTED STARTUP SIDEBAR"),
          "the replacement startup handler to receive mounted sidebar controls",
        );
      },
      broker.client,
    );
  });

  test("revokes retained panes and dialogs before a soft replacement shuts down", async () => {
    const repo = createTestRepo("hunk-apphost-retired-controls-");
    const logPath = join(repo, "retired.log");
    const extPath = join(repo, "retired.ts");
    writeFileSync(
      extPath,
      `import { appendFileSync } from "node:fs";\n` +
        `import { createElement } from "react";\n` +
        `export default function (hunk) {\n` +
        `  const paneText = ["RETIRED", "CONTROL", "PANE"].join(" ");\n` +
        `  const dialogTitle = ["RETIRED", "CONTROL", "DIALOG"].join(" ");\n` +
        `  hunk.registerPane({\n` +
        `    id: "retired", title: "Retired", placement: "right", width: { preferred: 20, min: 10, max: 40 },\n` +
        `    component: () => createElement("text", { content: paneText }),\n` +
        `  });\n` +
        `  hunk.on("startup", () => appendFileSync(${JSON.stringify(logPath)}, "startup\\n"));\n` +
        `  hunk.on("shutdown", async (_payload, ctx) => {\n` +
        `    ctx.panes.open("retired");\n` +
        `    ctx.navigation.selectFile("retired-file");\n` +
        `    const answer = await ctx.dialogs.confirm({ title: dialogTitle });\n` +
        `    appendFileSync(${JSON.stringify(logPath)}, "shutdown:" + answer + "\\n");\n` +
        `  });\n` +
        `}\n`,
    );
    useTempConfigHome();

    const bootstrap = await launchInSubdirectory(repo, { extensionPaths: [extPath] });
    bootstrap.extensions = await loadStartupExtensions({
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      cwd: join(repo, "sub"),
      cliExtensionPaths: [extPath],
    });
    expect(bootstrap.extensions.issues).toEqual([]);

    await withAppHost(bootstrap, async (setup) => {
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("startup"),
        "the retiring extension to receive startup",
      );
      await act(async () => {
        await setup.mockInput.typeText("r");
      });
      await flushUntil(
        setup,
        () => readProbeLog(logPath).includes("shutdown:false"),
        "retired shutdown controls to resolve without entering replacement UI",
      );
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("ignored — the review session was reloaded"),
        "the retired-control reload notice to render",
      );

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("RETIRED CONTROL DIALOG");
      expect(frame).not.toContain("RETIRED CONTROL PANE");
      expect(frame).toContain("ignored — the review session was reloaded");
    });
  });

  test("shuts down and starts each replacement extension instance", async () => {
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

      // The old instance remains live until the replacement review succeeds,
      // then shuts down before the mounted replacement receives startup.
      const events = readProbeLog(logPath);
      expect(events.filter((line) => line === "factory")).toHaveLength(2);
      expect(events.filter((line) => line === "startup")).toHaveLength(2);
      expect(events.lastIndexOf("factory")).toBeLessThan(events.indexOf("shutdown"));
      expect(events.indexOf("shutdown")).toBeLessThan(events.lastIndexOf("startup"));
      expect(events.lastIndexOf("startup")).toBeLessThan(events.indexOf("session_reload"));
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
