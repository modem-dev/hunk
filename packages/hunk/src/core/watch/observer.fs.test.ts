import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch as chokidarWatch } from "chokidar";

import { createWatchController } from "./controller";
import { createWatchEventSource, createWatchObserver, type WatchObserver } from "./observer";
import type { WatchPlan } from "./plan";
import { createChunkedTreeWatcher } from "./portableTree";

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
async function startObserver(plan: WatchPlan, platform = process.platform) {
  let eventCount = 0;
  let pendingEvents = 0;
  const waiters: Array<() => void> = [];
  const observer = createWatchObserver(
    plan,
    {
      onEvent() {
        eventCount++;
        const waiter = waiters.shift();
        if (waiter) waiter();
        else pendingEvents++;
      },
      onError(error) {
        throw error;
      },
    },
    { platform },
  );
  cleanups.push(async () => {
    observer.close();
    await bounded(observer.closed);
  });
  await bounded(observer.ready);

  return {
    observer,
    get eventCount() {
      return eventCount;
    },
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

describe("filesystem watch observer", () => {
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

  test("observes atomic replacement in a recursive tree", async () => {
    const directory = await temporaryDirectory();
    const nestedDirectory = join(directory, "src", "nested");
    await mkdir(nestedDirectory, { recursive: true });
    const file = join(nestedDirectory, "file.ts");
    const temporary = join(nestedDirectory, ".file.ts.tmp");
    await writeFile(file, "before");
    const source = await startObserver({
      coverage: "hybrid",
      targets: [{ kind: "directory-tree", directory, ignoredRoots: [], sources: ["worktree"] }],
    });

    await writeFile(temporary, "after");
    await rename(temporary, file);
    await bounded(source.nextEvent());
  });

  test("observes files written into a newly created directory", async () => {
    const directory = await temporaryDirectory();
    const source = await startObserver({
      coverage: "hybrid",
      targets: [{ kind: "directory-tree", directory, ignoredRoots: [], sources: ["worktree"] }],
    });
    const nestedDirectory = join(directory, "new", "nested");

    await mkdir(nestedDirectory, { recursive: true });
    await bounded(source.nextEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const eventsAfterCreation = source.eventCount;
    await writeFile(join(nestedDirectory, "file.ts"), "content");
    await bounded(
      (async () => {
        while (source.eventCount === eventsAfterCreation) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
    );
  });

  // Exercise inotify re-registration rather than native recursive backends.
  for (const scenario of ["initial", "runtime", "new-child", "rename"] as const) {
    test.skipIf(process.platform !== "linux")(
      `portable batches observe writes after intermediate directory recreation (${scenario})`,
      async () => {
        const parent = await temporaryDirectory();
        const directory = join(parent, "root");
        const intermediate = join(directory, "a");
        const nested = join(intermediate, "b");
        await mkdir(directory);
        if (scenario !== "runtime") {
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, "file"), "before");
        }
        const source = await startObserver({
          coverage: "hybrid",
          targets: [{ kind: "directory-tree", directory, ignoredRoots: [], sources: ["worktree"] }],
        });
        if (scenario === "runtime") {
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, "file"), "before");
          await new Promise((resolve) => setTimeout(resolve, ABSENCE_MS));
        }
        const moved = join(parent, "moved");
        if (scenario === "rename") await rename(intermediate, moved);
        else await rm(intermediate, { recursive: true });
        // Let unlinkDir retire the old inode before recreating the same pathname.
        await new Promise((resolve) => setTimeout(resolve, ABSENCE_MS));
        if (scenario === "rename") await rename(moved, intermediate);
        else await mkdir(nested, { recursive: true });
        const destination = scenario === "new-child" ? join(intermediate, "c") : nested;
        await mkdir(destination, { recursive: true });
        // Discard earlier hints: both the subtree and intermediate inode must recover.
        for (const file of [join(destination, "new-file"), join(intermediate, "direct-file")]) {
          await new Promise((resolve) => setTimeout(resolve, ABSENCE_MS));
          const beforeWrite = source.eventCount;
          await writeFile(file, "after");
          await bounded(
            (async () => {
              while (source.eventCount === beforeWrite)
                await new Promise((resolve) => setTimeout(resolve, 5));
            })(),
          );
        }
      },
    );
  }

  test("does not refresh for excluded worktree metadata churn", async () => {
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

    // Windows may report only the basename from a recursive callback. That ambiguous hint is
    // intentionally conservative, so assert the user-visible signature/refresh policy instead.
    await expectNoRefresh(
      plan,
      () => readFileSync(worktreeFile, "utf8"),
      () => writeFile(metadata, "after"),
    );
  });

  // Creating directory symlinks requires privileges not guaranteed on Windows CI.
  test.skipIf(process.platform === "win32")(
    "portable batches prune ignored and symlinked trees",
    async () => {
      const parent = await temporaryDirectory();
      const directory = join(parent, "worktree");
      const ignored = join(directory, "node_modules");
      const external = join(parent, "external");
      await mkdir(ignored, { recursive: true });
      await mkdir(external);
      await writeFile(join(ignored, "dependency.ts"), "before");
      await writeFile(join(external, "external.ts"), "before");
      await symlink(external, join(directory, "linked"), "dir");
      const source = await startObserver(
        {
          coverage: "hybrid",
          targets: [
            { kind: "directory-tree", directory, ignoredRoots: [ignored], sources: ["worktree"] },
          ],
        },
        "linux",
      );
      const initialEvents = source.eventCount;
      await writeFile(join(ignored, "dependency.ts"), "after");
      await writeFile(join(external, "external.ts"), "after");
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_MS));
      expect(source.eventCount).toBe(initialEvents);
      await mkdir(join(directory, "new", "nested"), { recursive: true });
      await bounded(source.nextEvent());
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterCreation = source.eventCount;
      await writeFile(join(directory, "new", "nested", "file.ts"), "after");
      await bounded(
        (async () => {
          while (source.eventCount === afterCreation)
            await new Promise((resolve) => setTimeout(resolve, 5));
        })(),
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "a portable symlink root does not traverse its referent",
    async () => {
      const parent = await temporaryDirectory();
      const external = join(parent, "external");
      const directory = join(parent, "linked");
      await mkdir(join(external, "nested"), { recursive: true });
      const file = join(external, "nested", "file.ts");
      await writeFile(file, "before");
      await symlink(external, directory, "dir");
      const admitted: string[] = [];
      const source = createChunkedTreeWatcher(
        directory,
        () => false,
        () => {},
        {
          watch(paths, options) {
            admitted.push(...(typeof paths === "string" ? [paths] : paths));
            return chokidarWatch(paths, options);
          },
        },
      );
      cleanups.push(() => bounded(source.close()));
      await bounded(new Promise<void>((resolveReady) => source.whenReady(resolveReady)));
      await writeFile(file, "after");
      await new Promise((resolve) => setTimeout(resolve, ABSENCE_MS));
      // A symlink-root watcher can emit conservative hints from its parent. Assert the
      // traversal boundary, not absence of hints from that public Chokidar fallback.
      expect(admitted).toEqual([directory]);
    },
  );

  test("portable observation recovers a missing root without recursively watching its parent", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "missing");
    const errors: unknown[] = [];
    let events = 0;
    const observer = createWatchObserver(
      {
        coverage: "hybrid",
        targets: [{ kind: "directory-tree", directory, ignoredRoots: [], sources: ["worktree"] }],
      },
      {
        onEvent() {
          events++;
        },
        onError(error) {
          errors.push(error);
        },
      },
      { platform: "linux" },
    );
    cleanups.push(async () => {
      observer.close();
      await bounded(observer.closed);
    });
    await bounded(observer.ready);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "ENOENT" });
    for (let index = 0; index < 2; index++) {
      await mkdir(join(directory, "nested"), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeWrite = events;
      await writeFile(join(directory, "nested", "file.ts"), "content");
      await bounded(
        (async () => {
          while (events === beforeWrite) await new Promise((resolve) => setTimeout(resolve, 5));
        })(),
      );
      await rm(directory, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
