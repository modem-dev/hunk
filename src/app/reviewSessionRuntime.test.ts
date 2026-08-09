import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDeferred, createTestDiffFile } from "../../test/helpers/diff-helpers";
import { createWatchTestRuntime } from "../../test/helpers/watchTest";
import type { HunkConfigResolution } from "../core/config";
import type { AppBootstrap, CliInput } from "../core/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import type {
  HunkSessionBrokerClient,
  HunkSessionCommandResult,
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";
import { createSessionRegistration } from "../session/app/registration";
import type { SessionBootstrapResult } from "./sessionBootstrap";
import { createReviewSessionRuntime, type ReviewSessionRuntimeDeps } from "./reviewSessionRuntime";

/** Build a renderer-neutral bootstrap whose source stays inside the test process cwd. */
function createBootstrap(overrides: Partial<AppBootstrap> = {}) {
  return {
    ...createTestVcsAppBootstrap({
      files: [createTestDiffFile({ path: "alpha.ts" })],
      sourceLabel: process.cwd(),
      title: "initial",
    }),
    ...overrides,
  };
}

/** Create a canonical reload seam that turns the requested theme into visible content. */
function createReloadDeps(
  load?: (
    input: CliInput,
    cwd: string,
    extensions: AppBootstrap["extensions"],
  ) => Promise<AppBootstrap>,
): ReviewSessionRuntimeDeps {
  return {
    resolveConfiguredCliInputImpl: ((input: CliInput) => ({
      input,
      customThemes: [],
      extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
      keybindings: {},
      startupNotices: [],
    })) as typeof import("../core/config").resolveConfiguredCliInput,
    loadConfiguredSessionBootstrapImpl: (async ({ configured, cwd, extensions }) => {
      const input = (configured as HunkConfigResolution).input;
      const bootstrap = load
        ? await load(input, cwd, extensions)
        : {
            ...createBootstrap(),
            input,
            reloadContext: { cwd },
            changeset: {
              ...createBootstrap().changeset,
              title: input.options.theme ?? "reloaded",
            },
            extensions,
          };
      return {
        applied: { vcsAdapters: [], issues: [] },
        bootstrap,
        input,
        sessionThemes: { themes: [], notices: [] },
        sessionVcs: { vcsId: input.options.vcs },
      } as SessionBootstrapResult;
    }) as typeof import("./sessionBootstrap").loadConfiguredSessionBootstrap,
  };
}

/** Return one reload input distinguished by a title-bearing theme option. */
function reloadInput(theme: string): CliInput {
  return { kind: "vcs", staged: false, options: { theme } };
}

/** Capture broker publications and expose the command bridge for headless lifecycle tests. */
function createHeadlessHostClient(bootstrap: AppBootstrap, onReplace?: () => void) {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];
  let bridge: Bridge = null;
  let registration = createSessionRegistration(bootstrap);
  const updated: HunkSessionSnapshot[] = [];
  const replaced: HunkSessionSnapshot[] = [];
  const hostClient = {
    getRegistration: () => registration,
    updateSnapshot: (snapshot: HunkSessionSnapshot) => updated.push(snapshot),
    setBridge: (next: Bridge) => {
      bridge = next;
    },
    replaceSession: (nextRegistration: HunkSessionRegistration, snapshot: HunkSessionSnapshot) => {
      onReplace?.();
      registration = nextRegistration;
      replaced.push(snapshot);
    },
  } as unknown as HunkSessionBrokerClient;
  return {
    hostClient,
    getBridge: () => bridge,
    dispatchCommand(message: HunkSessionServerMessage) {
      if (!bridge) throw new Error("Session command adapter is unavailable during cutover.");
      return bridge.dispatchCommand(message);
    },
    updated,
    replaced,
  };
}

describe("ReviewSessionRuntime", () => {
  test("owns the initial document, resources, store, and launch bounds headlessly", () => {
    const runtime = createReviewSessionRuntime(createBootstrap());
    const snapshot = runtime.getSnapshot();

    expect(snapshot.bootstrap.changeset.title).toBe("initial");
    expect(snapshot.store.getSnapshot().document).toBe(snapshot.projection.document);
    const patchId = snapshot.projection.document.files[0]!.patchResourceId;
    expect(runtime.getResource(patchId)).toBe(snapshot.bootstrap.changeset.files[0]!.patch);
    expect(runtime.getReloadBounds().roots).toEqual([process.cwd()]);
    runtime.dispose();
  });

  test("publishes headless store dispatches and retires old-store broker callbacks", async () => {
    const bootstrap = createBootstrap();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
    });
    const previousStore = runtime.getSnapshot().store;

    previousStore.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated.at(-1)?.state.showAgentNotes).toBe(true);

    await runtime.reload("manual", reloadInput("next"), { resetApp: false });
    const publicationsAfterReload = host.updated.length;
    previousStore.dispatch({ type: "notes/set-visibility", visible: false });
    expect(host.updated).toHaveLength(publicationsAfterReload);

    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: false });
    expect(host.updated.at(-1)?.state.showAgentNotes).toBe(false);
    runtime.dispose();
  });

  test("makes commands unavailable during atomic broker cutover and never mutates retired state", async () => {
    const bootstrap = createBootstrap();
    let cutoverAttempt = "not-attempted";
    let host!: ReturnType<typeof createHeadlessHostClient>;
    host = createHeadlessHostClient(bootstrap, () => {
      try {
        void host.dispatchCommand({
          type: "command",
          requestId: "cutover-race",
          command: "clear_comments",
          input: { sessionId: "session" },
        });
        cutoverAttempt = "routed";
      } catch {
        cutoverAttempt = "unavailable";
      }
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
    });
    const previousStore = runtime.getSnapshot().store;
    const adapter = {
      async dispatchCommand(_message: HunkSessionServerMessage): Promise<HunkSessionCommandResult> {
        previousStore.dispatch({ type: "notes/set-visibility", visible: true });
        return { removedCount: 0, remainingCommentCount: 0 };
      },
    };
    runtime.registerSessionCommandAdapter(previousStore, adapter);

    await runtime.reload("manual", reloadInput("cutover"), { resetApp: false });
    expect(cutoverAttempt).toBe("unavailable");
    expect(host.getBridge()).not.toBeNull();
    expect(runtime.getSnapshot().store.getSnapshot().showAgentNotes).toBe(false);

    // Even a caller retaining the old adapter can only reach a generation-guarded retired store.
    previousStore.dispatch({ type: "notes/set-visibility", visible: true });
    expect(runtime.getSnapshot().store.getSnapshot().showAgentNotes).toBe(false);
    runtime.dispose();
  });

  test("manual reload atomically replaces bootstrap, resources, and reconciled store", async () => {
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(),
      rawInput: reloadInput("manual-title"),
    });
    const previous = runtime.getSnapshot();
    previous.store.dispatch({ type: "filter/set", filter: "alpha" });

    await runtime.reload("manual", reloadInput("manual-title"), { resetApp: false });
    const next = runtime.getSnapshot();

    expect(next.bootstrap.changeset.title).toBe("manual-title");
    expect(next.projection.document.title).toBe("manual-title");
    expect(next.store).not.toBe(previous.store);
    expect(next.store.getSnapshot().filter).toBe("alpha");
    expect(next.store.getSnapshot().document).toBe(next.projection.document);
    runtime.dispose();
  });

  test("a slow older request cannot publish after a newer requested reload", async () => {
    const older = createTestDeferred<AppBootstrap>();
    const loadedThemes: string[] = [];
    const deps = createReloadDeps(async (input, cwd, extensions) => {
      const theme = input.options.theme ?? "none";
      loadedThemes.push(theme);
      if (theme === "older") return older.promise;
      return {
        ...createBootstrap(),
        input,
        reloadContext: { cwd },
        changeset: { ...createBootstrap().changeset, title: theme },
        extensions,
      };
    });
    const runtime = createReviewSessionRuntime(createBootstrap(), { deps });
    const olderResult = runtime.reload("daemon", reloadInput("older"), { resetApp: false });
    await Bun.sleep(0);
    const newerResult = runtime.reload("daemon", reloadInput("newer"), { resetApp: false });
    older.resolve({
      ...createBootstrap(),
      input: reloadInput("older"),
      changeset: { ...createBootstrap().changeset, title: "older" },
    });

    await Promise.all([olderResult, newerResult]);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("newer");
    expect(runtime.getSnapshot().revision).toBe(1);
    expect(loadedThemes).toEqual(["older", "newer"]);
    runtime.dispose();
  });

  test("watch patch and agent-sidecar hints reload through the same serialized path", async () => {
    const watch = createWatchTestRuntime();
    let reloads = 0;
    let plannedInput: CliInput | undefined;
    const bootstrap = createBootstrap({
      input: {
        kind: "patch",
        file: "review.patch",
        text: "diff --git a/a b/a\n",
        options: { watch: true, agentContext: "review.agent.json" },
      },
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(async (input, cwd, extensions) => {
        reloads += 1;
        return {
          ...bootstrap,
          input,
          reloadContext: { cwd },
          changeset: { ...bootstrap.changeset, title: `watch-${reloads}` },
          extensions,
        };
      }),
      watchRuntime: {
        ...watch.runtime,
        resolvePlan(input) {
          plannedInput = input;
          return {
            coverage: "hybrid",
            targets: [
              {
                kind: "directory-entries",
                directory: process.cwd(),
                entries: ["review.patch", "review.agent.json"],
                sources: ["content", "sidecar"],
              },
            ],
          };
        },
      },
    });
    runtime.start();
    watch.setSignature("signature:1");
    watch.emit();
    watch.advanceBy(200);
    for (let attempt = 0; attempt < 20 && reloads === 0; attempt++) await Bun.sleep(0);

    expect(plannedInput?.kind).toBe("patch");
    expect(plannedInput?.options.agentContext).toBe("review.agent.json");
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("watch-1");
    runtime.dispose();
  });

  test("executes the configured transform pipeline once for one winning generation", async () => {
    const transformPipeline = mock(async (input: CliInput, cwd: string) => ({
      ...createBootstrap(),
      input,
      reloadContext: { cwd },
      changeset: { ...createBootstrap().changeset, title: "transformed-once" },
    }));
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(transformPipeline),
    });

    await runtime.reload("manual", reloadInput("raw"), { resetApp: false });
    expect(transformPipeline).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().projection.document.title).toBe("transformed-once");
    runtime.dispose();
  });

  test("keeps repo extensions pending until a headless trust action approves and reloads", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    extensions.pendingTrustRepoRoot = process.cwd();
    const writeTrust = mock(() => "state.json");
    const discover = mock(async () => createEmptyExtensionLoadResult(process.cwd()));
    const runtime = createReviewSessionRuntime(createBootstrap({ extensions }), {
      deps: {
        ...createReloadDeps(),
        writeExtensionTrustImpl: writeTrust,
        loadStartupExtensionsImpl: discover,
      },
    });

    expect(runtime.getSnapshot().trust.promptRepoRoot).toBe(process.cwd());
    expect(discover).toHaveBeenCalledTimes(0);
    await runtime.decideExtensionTrust("trusted");
    expect(writeTrust).toHaveBeenCalledWith(process.cwd(), "trusted");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().trust.promptRepoRoot).toBeNull();
    runtime.dispose();
  });

  test("applies config at the validated source cwd and rejects an escaping source", async () => {
    const deps = createReloadDeps();
    const resolveConfigured = deps.resolveConfiguredCliInputImpl!;
    deps.loadStartupExtensionsImpl = async ({ cwd }) =>
      createEmptyExtensionLoadResult(cwd ?? process.cwd());
    const configuredCwds: Array<string | undefined> = [];
    deps.resolveConfiguredCliInputImpl = ((input, options) => {
      configuredCwds.push(options?.cwd);
      return resolveConfigured(input, options);
    }) as typeof resolveConfigured;
    const runtime = createReviewSessionRuntime(createBootstrap(), { deps });

    await runtime.reload("daemon", reloadInput("inside"), {
      resetApp: false,
      sourcePath: "src",
    });
    expect(configuredCwds).toEqual([resolve(process.cwd(), "src")]);
    await expect(
      runtime.reload("daemon", reloadInput("escape"), { sourcePath: "../outside" }),
    ).rejects.toThrow("outside the initial Hunk root");
    expect(configuredCwds).toHaveLength(1);
    runtime.dispose();
  });

  test("re-resolves local reloads from raw invocation and current source cwd", async () => {
    let configuredTheme = "config-one";
    const configuredInputs: Array<{ cwd?: string; input: CliInput }> = [];
    const deps = createReloadDeps();
    deps.resolveConfiguredCliInputImpl = ((input: CliInput, options?: { cwd?: string }) => {
      configuredInputs.push({ cwd: options?.cwd, input });
      return {
        input: { ...input, options: { ...input.options, theme: configuredTheme } },
        customThemes: [],
        extensions: { enabled: true, paths: [], repoPaths: [], extensionConfigs: {} },
        keybindings: {},
        startupNotices: [],
      };
    }) as typeof import("../core/config").resolveConfiguredCliInput;
    const rawInput: CliInput = { kind: "vcs", staged: false, options: {} };
    const bootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { theme: "old-config" } },
    });
    const runtime = createReviewSessionRuntime(bootstrap, { deps, rawInput });

    configuredTheme = "config-two";
    await runtime.reload("manual", bootstrap.input, {
      resetApp: false,
      sourcePath: "src",
    });
    expect(configuredInputs.at(-1)?.cwd).toBe(resolve(process.cwd(), "src"));
    expect(configuredInputs.at(-1)?.input.options.theme).toBeUndefined();
    expect(runtime.getSnapshot().bootstrap.input.options.theme).toBe("config-two");

    await runtime.reload("daemon", reloadInput("daemon-explicit"), { resetApp: false });
    expect(configuredInputs.at(-1)?.input.options.theme).toBe("daemon-explicit");
    runtime.dispose();
  });

  test("dispose immediately closes a freshly discovered registry while transforms remain pending", async () => {
    const transform = createTestDeferred<AppBootstrap>();
    const freshExtensions = createEmptyExtensionLoadResult(process.cwd());
    let phase = freshExtensions.registry.eventBusPhase;
    let closeWrites = 0;
    Object.defineProperty(freshExtensions.registry, "eventBusPhase", {
      configurable: true,
      get: () => phase,
      set(next: typeof phase) {
        phase = next;
        if (next === "closed") closeWrites += 1;
      },
    });
    const loadExtensions = mock(async () => freshExtensions);
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: {
        ...createReloadDeps(async () => transform.promise),
        loadStartupExtensionsImpl: loadExtensions,
      },
    });
    const reload = runtime
      .reload("manual", reloadInput("pending-transform"), {
        reloadExtensions: true,
        resetApp: false,
      })
      .catch((error) => error);
    for (let attempt = 0; attempt < 20 && loadExtensions.mock.calls.length === 0; attempt++) {
      await Bun.sleep(0);
    }
    await Bun.sleep(0);

    runtime.dispose();
    expect(freshExtensions.registry.eventBusPhase).toBe("closed");
    expect(closeWrites).toBe(1);
    expect(await reload).toBeInstanceOf(Error);

    transform.resolve({
      ...createBootstrap(),
      changeset: { ...createBootstrap().changeset, title: "late-transform" },
      extensions: freshExtensions,
    });
    await Bun.sleep(0);
    expect(closeWrites).toBe(1);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("initial");
  });

  test("dispose during broker replacement skips binding, notification, watch, and lifecycle work", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    let reloadEvents = 0;
    extensions.registry.eventHandlers.session_reload.push({
      extensionId: "cutover-test",
      handler: () => {
        reloadEvents += 1;
      },
    });
    const bootstrap = createBootstrap({
      extensions,
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const watch = createWatchTestRuntime();
    let runtime!: ReturnType<typeof createReviewSessionRuntime>;
    const host = createHeadlessHostClient(bootstrap, () => runtime.dispose());
    runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
      watchRuntime: watch.runtime,
    });
    let notifications = 0;
    runtime.subscribe(() => {
      notifications += 1;
    });
    runtime.start();
    const updatesBeforeReload = host.updated.length;

    await expect(runtime.reload("manual", bootstrap.input, { resetApp: false })).rejects.toThrow(
      "disposed",
    );
    expect(notifications).toBe(0);
    expect(watch.sources).toHaveLength(1);
    expect(watch.sources[0]?.closeCount).toBe(1);
    expect(reloadEvents).toBe(0);
    expect(host.updated).toHaveLength(updatesBeforeReload);

    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated).toHaveLength(updatesBeforeReload);
  });

  test("dispose from a runtime subscriber stops later notifications, watch restart, and events", async () => {
    const extensions = createEmptyExtensionLoadResult(process.cwd());
    let reloadEvents = 0;
    extensions.registry.eventHandlers.session_reload.push({
      extensionId: "subscriber-cutover-test",
      handler: () => {
        reloadEvents += 1;
      },
    });
    const bootstrap = createBootstrap({
      extensions,
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const watch = createWatchTestRuntime();
    const host = createHeadlessHostClient(bootstrap);
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      hostClient: host.hostClient,
      watchRuntime: watch.runtime,
    });
    let laterNotifications = 0;
    runtime.subscribe(() => runtime.dispose());
    runtime.subscribe(() => {
      laterNotifications += 1;
    });
    runtime.start();

    await expect(runtime.reload("manual", bootstrap.input, { resetApp: false })).rejects.toThrow(
      "disposed",
    );
    expect(laterNotifications).toBe(0);
    expect(watch.sources).toHaveLength(1);
    expect(watch.sources[0]?.closeCount).toBe(1);
    expect(reloadEvents).toBe(0);
    const updatesAfterDispose = host.updated.length;
    runtime.getSnapshot().store.dispatch({ type: "notes/set-visibility", visible: true });
    expect(host.updated).toHaveLength(updatesAfterDispose);
  });

  test("dispose rejects an active deferred reload immediately and ignores late completion", async () => {
    const deferred = createTestDeferred<AppBootstrap>();
    const runtime = createReviewSessionRuntime(createBootstrap(), {
      deps: createReloadDeps(async () => deferred.promise),
    });
    const reload = runtime.reload("manual", reloadInput("pending"), { resetApp: false });
    await Bun.sleep(0);

    runtime.dispose();
    const settlement = await Promise.race([
      reload.then(
        () => "resolved",
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      Bun.sleep(50).then(() => "timed-out"),
    ]);
    expect(settlement).toContain("disposed");

    deferred.resolve({
      ...createBootstrap(),
      changeset: { ...createBootstrap().changeset, title: "late" },
    });
    await Bun.sleep(0);
    expect(runtime.getSnapshot().bootstrap.changeset.title).toBe("initial");
  });

  test("closes watch resources and rejects work after disposal", async () => {
    const watch = createWatchTestRuntime();
    const bootstrap = createBootstrap({
      input: { kind: "vcs", staged: false, options: { watch: true } },
    });
    const runtime = createReviewSessionRuntime(bootstrap, {
      deps: createReloadDeps(),
      watchRuntime: watch.runtime,
    });
    runtime.start();

    runtime.dispose();
    expect(watch.sources[0]?.closeCount).toBe(1);
    await expect(runtime.reload("manual")).rejects.toThrow("disposed");
  });
});
