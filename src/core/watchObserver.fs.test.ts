import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWatchController } from "./watchController";
import { createWatchEventSource, createWatchObserver, type WatchObserver } from "./watchObserver";
import type { WatchPlan } from "./watchPlan";

const WAIT_MS = 3_000;
const ABSENCE_MS = 250;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Reject when a lifecycle or filesystem event exceeds its explicit test bound. */
async function bounded<T>(promise: Promise<T>, timeoutMs = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Create a disposable real directory for one watcher test. */
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hunk-watch-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Build an exact-entry plan for one or more files in a shared parent directory. */
function entriesPlan(directory: string, entries: string[]): WatchPlan {
  return {
    coverage: "hybrid",
    targets: [{ kind: "directory-entries", directory, entries, sources: ["content"] }],
  };
}

/** Start an observer and expose queued events so mutations cannot race test listeners. */
async function startObserver(plan: WatchPlan) {
  let pendingEvents = 0;
  const waiters: Array<() => void> = [];
  const observer = createWatchObserver(plan, {
    onEvent() {
      const waiter = waiters.shift();
      if (waiter) waiter();
      else pendingEvents++;
    },
    onError(error) {
      throw error;
    },
  });
  cleanups.push(async () => {
    observer.close();
    await bounded(observer.closed);
  });
  await bounded(observer.ready);

  return {
    observer,
    nextEvent() {
      if (pendingEvents > 0) {
        pendingEvents--;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/** Assert that no observer event arrives during a short bounded interval. */
async function expectNoEvent(nextEvent: Promise<void>) {
  const outcome = await Promise.race([
    nextEvent.then(() => "event" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ABSENCE_MS)),
  ]);
  expect(outcome).toBe("timeout");
}

/** Verify an irrelevant mutation cannot refresh even when a backend emits a conservative hint. */
async function expectNoRefresh(
  plan: WatchPlan,
  getSignature: () => string,
  mutate: () => Promise<void>,
) {
  let observer!: WatchObserver;
  let checks = 0;
  let refreshes = 0;
  const controller = createWatchController({
    initialSignature: getSignature(),
    createEventSource: (callbacks) => {
      observer = createWatchObserver(plan, callbacks);
      return observer;
    },
    getSignature: () => {
      checks++;
      return getSignature();
    },
    refresh: () => {
      refreshes++;
    },
    quietDelayMs: 10,
    healthyCheckMs: 50,
  });
  cleanups.push(async () => {
    controller.close();
    await bounded(observer.closed);
  });
  await bounded(observer.ready);
  await mutate();
  await bounded(
    (async () => {
      while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    })(),
  );
  expect(refreshes).toBe(0);
}

describe("Chokidar watch observer", () => {
  test("does not create an event-source factory for poll-only plans", () => {
    expect(createWatchEventSource({ coverage: "poll-only", targets: [] })).toBeUndefined();
  });

  test("observes an ordinary file write after readiness", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "input.patch");
    await writeFile(file, "before");
    const source = await startObserver(entriesPlan(directory, [file]));

    await writeFile(file, "after");
    await bounded(source.nextEvent());
  });

  test("observes temp-file atomic replacement", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "input.patch");
    const temporary = join(directory, ".input.patch.tmp");
    await writeFile(file, "before");
    const source = await startObserver(entriesPlan(directory, [file]));

    await writeFile(temporary, "after");
    await rename(temporary, file);
    await bounded(source.nextEvent());
  });

  test("observes deletion and recreation", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "input.patch");
    await writeFile(file, "before");
    const source = await startObserver(entriesPlan(directory, [file]));

    await unlink(file);
    await bounded(source.nextEvent());
    await writeFile(file, "after");
    await bounded(source.nextEvent());
  });

  test("ignores sibling files for an exact-entry target", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.patch");
    const sibling = join(directory, "sibling.patch");
    await writeFile(target, "target");
    await writeFile(sibling, "before");
    const plan = entriesPlan(directory, [target]);

    await expectNoRefresh(
      plan,
      () => readFileSync(target, "utf8"),
      () => writeFile(sibling, "after"),
    );
  });

  test("observes recursive worktree events", async () => {
    const directory = await temporaryDirectory();
    const nestedDirectory = join(directory, "src", "nested");
    await mkdir(nestedDirectory, { recursive: true });
    const file = join(nestedDirectory, "file.ts");
    await writeFile(file, "before");
    const source = await startObserver({
      coverage: "hybrid",
      targets: [{ kind: "directory-tree", directory, ignoredRoots: [], sources: ["worktree"] }],
    });

    await writeFile(file, "after");
    await bounded(source.nextEvent());
  });

  test("excludes a worktree .git subtree when metadata is observed separately", async () => {
    const directory = await temporaryDirectory();
    const metadataDirectory = join(directory, ".git");
    await mkdir(metadataDirectory);
    const metadata = join(metadataDirectory, "index");
    const worktreeFile = join(directory, "file.ts");
    await writeFile(metadata, "before");
    await writeFile(worktreeFile, "before");
    const plan: WatchPlan = {
      coverage: "hybrid",
      targets: [
        {
          kind: "directory-tree",
          directory,
          ignoredRoots: [metadataDirectory],
          sources: ["worktree"],
        },
      ],
    };

    await expectNoRefresh(
      plan,
      () => readFileSync(worktreeFile, "utf8"),
      () => writeFile(metadata, "after"),
    );
  });

  test("close releases handles and suppresses later events", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "input.patch");
    await writeFile(file, "before");
    const source = await startObserver(entriesPlan(directory, [file]));

    source.observer.close();
    await bounded(source.observer.closed);
    await writeFile(file, "after");
    await expectNoEvent(source.nextEvent());
  });
});
