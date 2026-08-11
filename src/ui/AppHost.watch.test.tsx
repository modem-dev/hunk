import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../test/helpers/test-color-helpers";
import { createWatchTestRuntime } from "../../test/helpers/watchTest";
import { loadAppBootstrap } from "../core/loaders";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { createSessionRegistration } from "../session/app/registration";
import type { HunkSessionBrokerClient, HunkSessionServerMessage } from "../session/types";
import { AppHost } from "./AppHost";
import { resolveTheme } from "./themes";

/** Create an externally controlled promise for reload-race tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await Promise.resolve();
    await setup.renderOnce();
    await Promise.resolve();
    await setup.renderOnce();
  });
}

/**
 * Yield across render and filesystem turns until an asynchronous view update is visible.
 *
 * An expired wait throws rather than letting the test proceed against a stale
 * frame, so "the update never arrived" reads as exactly that.
 */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  description: string,
  attempts = 50,
) {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
    await flush(setup);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!predicate()) {
    throw new Error(`Timed out after ${attempts} render passes waiting for ${description}.`);
  }
}

/** Advance the injected watch debounce and settle its asynchronous soft reload. */
async function advanceWatch(
  setup: Awaited<ReturnType<typeof testRender>>,
  watch: ReturnType<typeof createWatchTestRuntime>,
  milliseconds: number,
) {
  await act(async () => {
    watch.advanceBy(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 12; attempt++) {
    await flush(setup);
  }
}

describe("watched input lifecycle", () => {
  test("an observer event reloads after the controlled debounce and preserves the resolved theme", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "split", theme: "auto", watch: true },
    });
    bootstrap.initialThemeMode = "light";
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 220,
      height: 20,
    });

    try {
      await flush(setup);
      expect(watch.sources).toHaveLength(1);
      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("after");
      });
      await flush(setup);
      writeFileSync(right, "export const answer = 42;\nexport const observed = true;\n");
      watch.setSignature("signature:1");
      watch.emit();

      await advanceWatch(setup, watch, 199);
      expect(setup.captureCharFrame()).not.toContain("observed");
      await advanceWatch(setup, watch, 1);
      expect(setup.captureCharFrame()).toContain("observed");
      expect(setup.captureCharFrame()).toContain("filter:");
      expect(setup.captureCharFrame()).toContain("after");
      expect(watch.sources).toHaveLength(2);
      expect(watch.sources[0]?.closeCount).toBe(1);

      const lightTheme = resolveTheme("auto", "light");
      const renderedBackgrounds = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .map((span) => capturedTestColorToHex(span.bg)?.toLowerCase());
      expect(renderedBackgrounds).toContain(lightTheme.panel.toLowerCase());
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a sidecar event refreshes notes through the canonical reload pipeline", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-sidecar-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    const sidecar = join(dir, "agent.json");
    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");
    writeFileSync(sidecar, JSON.stringify({ version: 1, files: [] }));

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: {
        agentContext: sidecar,
        agentNotes: true,
        mode: "stack",
        watch: true,
      },
    });
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 140,
      height: 24,
    });

    try {
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("Watch rationale updated");
      writeFileSync(
        sidecar,
        JSON.stringify({
          version: 1,
          files: [
            {
              path: "after.ts",
              annotations: [{ newRange: [1, 1], summary: "Watch rationale updated" }],
            },
          ],
        }),
      );
      watch.setSignature("signature:sidecar");
      watch.emit();
      await advanceWatch(setup, watch, 200);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("Watch rationale updated"),
        "the watched reload to show the updated rationale",
      );
      expect(setup.captureCharFrame()).toContain("Watch rationale updated");
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("superseded watch reloads and retries cannot replace newer daemon content", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-race-ui-"));
    const left = join(dir, "before.ts");
    const watchedRight = join(dir, "watched.ts");
    const daemonRight = join(dir, "daemon.ts");
    writeFileSync(left, "export const state = 'before';\n");
    writeFileSync(watchedRight, "export const state = 'initial';\n");
    writeFileSync(daemonRight, "export const state = 'daemon current';\n");
    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right: watchedRight,
      options: { mode: "stack", watch: true },
    });
    const watchTransformStarted = deferred<void>();
    const watchTransformFinished = deferred<void>();
    const releaseWatchTransform = deferred<void>();
    const daemonTransformStarted = deferred<void>();
    const releaseDaemonTransform = deferred<void>();
    const extensions = createEmptyExtensionLoadResult(dir);
    let transformCalls = 0;
    extensions.registry.changesetTransforms.push({
      extensionId: "slow-watch-transform",
      async transform(changeset) {
        transformCalls++;
        if (transformCalls === 1) {
          watchTransformStarted.resolve();
          await releaseWatchTransform.promise;
          watchTransformFinished.resolve();
          return { ...changeset, title: "retired watch" };
        }
        if (transformCalls === 2) {
          daemonTransformStarted.resolve();
          await releaseDaemonTransform.promise;
          return { ...changeset, title: "daemon current" };
        }
        return changeset;
      },
    });
    bootstrap.extensions = extensions;

    let registration = createSessionRegistration(bootstrap);
    const publishedTitles: string[] = [];
    let bridge: { dispatchCommand(message: HunkSessionServerMessage): Promise<unknown> } | null =
      null;
    const hostClient = {
      setBridge(nextBridge: typeof bridge) {
        bridge = nextBridge;
      },
      updateSnapshot() {},
      getRegistration() {
        return registration;
      },
      replaceSession(nextRegistration: typeof registration) {
        registration = nextRegistration;
        publishedTitles.push(nextRegistration.info.title);
      },
    } as unknown as HunkSessionBrokerClient;
    const watch = createWatchTestRuntime();
    const setup = await testRender(
      <AppHost bootstrap={bootstrap} hostClient={hostClient} watchRuntime={watch.runtime} />,
      { width: 120, height: 20 },
    );

    try {
      await flush(setup);
      expect(bridge).not.toBeNull();
      writeFileSync(watchedRight, "export const state = 'retired watch';\n");
      watch.setSignature("signature:retired");
      watch.emit();
      await advanceWatch(setup, watch, 200);
      await watchTransformStarted.promise;

      const activeBridge = bridge!;
      const daemonReload = activeBridge.dispatchCommand({
        type: "command",
        requestId: "reload-newer",
        command: "reload_session",
        input: {
          sessionId: registration.sessionId,
          nextInput: {
            kind: "diff",
            left,
            right: daemonRight,
            options: { mode: "stack" },
          },
        },
      });
      await daemonTransformStarted.promise;

      // Finish the old watch reload after the newer generation has started but
      // before React can commit it and abort the old hook. Signal-only guards
      // miss this interval; the host generation must reject publication.
      releaseWatchTransform.resolve();
      await watchTransformFinished.promise;
      await flush(setup);
      expect(publishedTitles).not.toContain("retired watch");

      // The superseded controller retains its old signature so it can retry.
      // While the explicit replacement is still pending, that retry must not
      // become a newer generation and cancel the replacement.
      watch.emit(0);
      await advanceWatch(setup, watch, 200);
      expect(publishedTitles).not.toContain("retired watch");

      releaseDaemonTransform.resolve();
      await act(async () => await daemonReload);
      await flushUntil(
        setup,
        () => setup.captureCharFrame().includes("daemon current"),
        "the newer daemon reload to render",
      );
      expect(publishedTitles).toEqual(["daemon current"]);
      expect(setup.captureCharFrame()).not.toContain("retired watch");
    } finally {
      releaseWatchTransform.resolve();
      releaseDaemonTransform.resolve();
      await act(async () => setup.renderer.destroy());
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("replacement and unmount dispose observers once while late events remain inert", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".hunk-watch-dispose-ui-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "first\n");
    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: { mode: "stack", watch: true },
    });
    const watch = createWatchTestRuntime();
    const setup = await testRender(<AppHost bootstrap={bootstrap} watchRuntime={watch.runtime} />, {
      width: 120,
      height: 20,
    });

    try {
      await flush(setup);
      const oldSource = watch.sources[0]!;
      writeFileSync(right, "second\n");
      watch.setSignature("signature:replacement");
      watch.emit(0);
      await advanceWatch(setup, watch, 200);
      expect(watch.sources).toHaveLength(2);
      expect(oldSource.closeCount).toBe(1);

      writeFileSync(right, "late\n");
      watch.setSignature("signature:late");
      oldSource.callbacks.onEvent();
      await advanceWatch(setup, watch, 200);
      expect(setup.captureCharFrame()).not.toContain("late");
      expect(watch.sources).toHaveLength(2);

      await act(async () => setup.renderer.destroy());
      expect(oldSource.closeCount).toBe(1);
      expect(watch.sources[1]?.closeCount).toBe(1);
      oldSource.callbacks.onEvent();
      watch.sources[1]?.callbacks.onEvent();
      watch.advanceBy(10_000);
      expect(watch.sources[1]?.closeCount).toBe(1);
    } finally {
      setup.renderer.destroy();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
