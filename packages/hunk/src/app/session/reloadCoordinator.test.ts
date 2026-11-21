import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadAppBootstrap } from "../../core/changeset/loaders";
import type { CliInput } from "../../core/run/commandInputs";
import { startInputWatch } from "../../core/watch/inputWatch";
import { createTestDeferred } from "../../../../../test/helpers/diff-helpers";
import { createTestExtensionSession } from "../../../../../test/helpers/extension-session";
import { createWatchTestRuntime } from "../../../../../test/helpers/watchTest";
import {
  ReviewReloadCoordinator,
  withReloadVcsCatalog,
  type ReviewReloadAdoption,
} from "./reloadCoordinator";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** Write a two-file diff input into a fresh temporary directory. */
function createTestDiffInput(): { input: CliInput; right: string; dir: string } {
  const dir = mkdtempSync(join(process.cwd(), ".hunk-reload-coordinator-"));
  directories.push(dir);
  const left = join(dir, "before.ts");
  const right = join(dir, "after.ts");
  writeFileSync(left, "export const answer = 41;\n");
  writeFileSync(right, "export const answer = 42;\n");
  return { input: { kind: "diff", left, right, options: { mode: "split" } }, right, dir };
}

/** Create a coordinator over a loaded diff whose adoptions the test controls. */
async function createTestCoordinator(
  adopt: (adoption: ReviewReloadAdoption) => Promise<void> | void = () => {},
  onRefreshFailed?: (detail: string) => void,
) {
  const { input, right, dir } = createTestDiffInput();
  const bootstrap = withReloadVcsCatalog(await loadAppBootstrap(input));
  const coordinator = new ReviewReloadCoordinator({
    bootstrap,
    extensionSession: createTestExtensionSession(dir),
    extensionLifecycleEnabled: false,
    extensionOwnership: "borrowed",
    adopt,
    ...(onRefreshFailed ? { onRefreshFailed } : {}),
  });
  return { coordinator, input, right, dir };
}

/** Let queued reload work reach its next await; use only to show that nothing further happens. */
async function settleTestTurns() {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait until reload work that reads real files has reached an observable state.
 *
 * A reload awaits filesystem reads, so a fixed number of timer turns says nothing about
 * whether it has got there on a busy machine.
 */
async function waitForTestCondition(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the reload coordinator test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ReviewReloadCoordinator", () => {
  test("serializes overlapping reloads behind each adoption and advances the generation", async () => {
    const adoptions: Array<{ adoption: ReviewReloadAdoption; mounted: () => void }> = [];
    const { coordinator, input } = await createTestCoordinator((adoption) => {
      const mounted = createTestDeferred<void>();
      adoptions.push({ adoption, mounted: () => mounted.resolve() });
      return mounted.promise;
    });
    const initialGeneration = coordinator.producer.getPublication().generation;

    const first = coordinator.reload(input, { resetApp: false });
    const second = coordinator.reload(input);
    await waitForTestCondition(() => adoptions.length >= 1);
    await settleTestTurns();
    // The second reload waits until the first replacement reports itself mounted.
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]?.adoption.resetApp).toBe(false);
    const firstGeneration = coordinator.producer.getPublication().generation;
    expect(firstGeneration).not.toBe(initialGeneration);

    adoptions[0]?.mounted();
    expect((await first).fileCount).toBe(1);
    await waitForTestCondition(() => adoptions.length >= 2);
    expect(adoptions).toHaveLength(2);
    expect(adoptions[1]?.adoption.resetApp).toBe(true);
    adoptions[1]?.mounted();
    await second;
    expect(coordinator.producer.getPublication().generation).not.toBe(firstGeneration);
    expect(coordinator.getBootstrap()).toBe(adoptions[1]!.adoption.bootstrap);
  });

  test("a failed reload leaves the previous review mounted and published", async () => {
    let adoptions = 0;
    const { coordinator, input, dir } = await createTestCoordinator(() => {
      adoptions += 1;
    });
    const before = coordinator.producer.getPublication().generation;
    const launch = coordinator.getBootstrap();

    await expect(
      coordinator.reload({ ...input, right: join(dir, "missing.ts") } as CliInput),
    ).rejects.toThrow();
    expect(adoptions).toBe(0);
    expect(coordinator.producer.getPublication().generation).toBe(before);
    expect(coordinator.getBootstrap()).toBe(launch);

    // The queue survives the failure.
    await coordinator.reload(input);
    expect(adoptions).toBe(1);
  });

  test("refuses reloads and new writes once shutdown begins, including one already loading", async () => {
    let adoptions = 0;
    const { coordinator, input } = await createTestCoordinator(() => {
      adoptions += 1;
    });

    const inFlight = coordinator.reload(input);
    expect(coordinator.beginShutdown()).toBe(true);
    expect(coordinator.beginShutdown()).toBe(false);
    await expect(inFlight).rejects.toThrow("shutting down and cannot reload");
    await expect(coordinator.reload(input)).rejects.toThrow("shutting down and cannot reload");
    expect(adoptions).toBe(0);
    expect(await coordinator.runWorkspaceWrite(async () => {})).toBe(false);
    expect(await coordinator.requestExtensionReviewReload(coordinator.getBootstrap())).toEqual({
      ok: false,
      reason: "unavailable",
      detail: "The review session is shutting down and cannot reload.",
    });
  });

  test("waits for writes started before shutdown", async () => {
    const { coordinator } = await createTestCoordinator();
    const write = createTestDeferred<void>();
    const started = coordinator.runWorkspaceWrite(() => write.promise);
    coordinator.beginShutdown();
    let settled = false;
    const settling = coordinator.settleStartedWrites().then(() => {
      settled = true;
    });
    await settleTestTurns();
    expect(settled).toBe(false);
    write.resolve();
    await settling;
    expect(await started).toBe(true);
  });

  test("deferred refreshes use the latest registered descriptor and coalesce extension requests", async () => {
    const adopted: string[] = [];
    const { coordinator, input } = await createTestCoordinator((adoption) => {
      adopted.push(adoption.bootstrap.input.kind);
    });

    expect(await coordinator.requestExtensionReviewReload(coordinator.getBootstrap())).toEqual({
      ok: false,
      reason: "unavailable",
      detail: "The current review cannot be reloaded from its original input.",
    });

    const unregisterStale = coordinator.registerRefreshRequest({ nextInput: input });
    coordinator.registerRefreshRequest({ nextInput: input });
    // A superseded registration's cleanup must not clear its successor.
    unregisterStale();

    const generation = coordinator.getBootstrap();
    const first = coordinator.requestExtensionReviewReload(generation);
    expect(coordinator.requestExtensionReviewReload(generation)).toBe(first);
    expect(await first).toEqual({ ok: true });

    coordinator.reloadAfterWorkspaceWrite();
    await waitForTestCondition(() => adopted.length >= 2);
    await settleTestTurns();
    expect(adopted).toEqual(["diff", "diff"]);
  });

  test("a watch change drives a soft reload through the coordinator", async () => {
    const adoptions: ReviewReloadAdoption[] = [];
    const { coordinator, input, right } = await createTestCoordinator((adoption) => {
      adoptions.push(adoption);
    });
    const watch = createWatchTestRuntime();
    const reasons: string[] = [];
    const watcher = startInputWatch({
      input,
      reloadContext: coordinator.getBootstrap().reloadContext,
      refresh: async () => {
        reasons.push("watch");
        await coordinator.reload(input, { reason: "watch", resetApp: false });
      },
      runtime: watch.runtime,
    });

    try {
      writeFileSync(right, "export const answer = 42;\nexport const observed = true;\n");
      watch.setSignature("signature:1");
      watch.emit();
      watch.advanceBy(200);
      await waitForTestCondition(() => adoptions.length >= 1);

      expect(reasons).toEqual(["watch"]);
      expect(adoptions).toHaveLength(1);
      expect(adoptions[0]?.resetApp).toBe(false);
      expect(adoptions[0]?.bootstrap.changeset.files[0]?.metadata.hunks.length).toBeGreaterThan(0);
    } finally {
      watcher?.close();
    }
  });

  test("refreshes the registered input once for a burst of requests", async () => {
    let adoptions = 0;
    const { coordinator, input } = await createTestCoordinator(() => {
      adoptions += 1;
    });
    expect(await coordinator.refreshCurrent()).toMatchObject({
      ok: false,
      code: "refresh-unavailable",
    });

    coordinator.registerRefreshRequest({ nextInput: input });
    const first = coordinator.refreshCurrent();
    expect(coordinator.refreshCurrent()).toBe(first);
    const result = await first;
    expect(result).toEqual({ ok: true, ...coordinator.producer.getPublicationAddress() });
    expect(adoptions).toBe(1);

    coordinator.registerRefreshRequest({
      nextInput: {
        ...input,
        right: join(input.kind === "diff" ? input.left : "", "..", "gone.ts"),
      } as CliInput,
    });
    expect(await coordinator.refreshCurrent()).toMatchObject({ ok: false, code: "refresh-failed" });
    expect(adoptions).toBe(1);
  });

  // Finding: a failed refresh answered the browser with the reload's own error text, which can
  // carry VCS stderr and absolute paths. The detail now stays in the session's notice path.
  test("keeps a failed refresh's detail in the session and answers with a fixed message", async () => {
    const details: string[] = [];
    const { coordinator, input } = await createTestCoordinator(undefined, (detail) =>
      details.push(detail),
    );
    const gone = join(input.kind === "diff" ? input.left : "", "..", "gone.ts");
    coordinator.registerRefreshRequest({ nextInput: { ...input, right: gone } as CliInput });

    const result = await coordinator.refreshCurrent();

    expect(result).toEqual({
      ok: false,
      code: "refresh-failed",
      message: "The review could not be reloaded from its input.",
    });
    expect(details).toHaveLength(1);
    expect(details[0]).toStartWith("Failed to reload the current review:");
  });
});
