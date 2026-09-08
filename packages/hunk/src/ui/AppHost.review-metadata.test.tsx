import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { createWatchTestRuntime } from "../../../../test/helpers/watchTest";
import { getBundledVcsCatalog } from "../app/vcsCatalog";
import type { AppBootstrap } from "../core/bootstrap";
import { loadAppBootstrap } from "../core/changeset/loaders";
import type { HunkSessionBrokerClient } from "../session/broker/brokerClient";
import type {
  HunkSessionRegistration,
  HunkSessionServerMessage,
  HunkSessionSnapshot,
} from "../session/types";
import { TestAppHost as AppHost } from "../../../../test/helpers/app-host";

/** Stand in for the daemon so a mounted AppHost can receive unrelated reloads. */
function createTestHostClient() {
  type Bridge = Parameters<HunkSessionBrokerClient["setBridge"]>[0];
  let bridge: Bridge = null;
  let registration: HunkSessionRegistration = {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    launchedAt: "2026-09-04T00:00:00.000Z",
    info: { inputKind: "patch", title: "Patch", sourceLabel: "Patch", files: [] },
  };

  return {
    hostClient: {
      getRegistration: () => registration,
      replaceSession: (nextRegistration: HunkSessionRegistration) => {
        registration = nextRegistration;
      },
      setBridge: (nextBridge: Bridge) => {
        bridge = nextBridge;
      },
      updateSnapshot: (_snapshot: HunkSessionSnapshot) => {},
    } as unknown as HunkSessionBrokerClient,
    dispatchCommand: async (message: HunkSessionServerMessage) => {
      if (!bridge) throw new Error("Expected AppHost to register its daemon bridge.");
      return bridge.dispatchCommand(message);
    },
  };
}

/** Write a minimal unified patch whose content marker changes across reloads. */
function writeTestPatch(path: string, marker: string) {
  writeFileSync(
    path,
    [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1 +1 @@",
      "-before",
      `+${marker}`,
      "",
    ].join("\n"),
  );
}

/** Create a repository-backed patch fixture so AppHost may reload sibling inputs. */
async function createTestBootstrap({ watch = false }: { watch?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hunk-review-metadata-host-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" });
  const firstPatch = join(directory, "first.diff");
  const secondPatch = join(directory, "second.diff");
  writeTestPatch(firstPatch, "first");
  writeTestPatch(secondPatch, "second");
  const bootstrap = await loadAppBootstrap(
    { kind: "patch", file: firstPatch, options: { mode: "unified", watch } },
    { cwd: directory },
  );
  bootstrap.review = Object.freeze({
    kind: "change-request",
    provider: "GitHub",
    title: "Metadata pane",
    id: "#123",
    repository: "modem-dev/hunk",
    author: "octocat",
    base: "main",
    head: "feature/review-info",
    state: "open",
  });
  return { bootstrap, directory, firstPatch, secondPatch };
}

/** Create a commit review launched below its repository root. */
async function createHistoryCommitBootstrap() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-review-commit-host-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" });
  const file = join(directory, "example.txt");
  writeFileSync(file, "before\n");
  execFileSync("git", ["add", "example.txt"], { cwd: directory, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=History Tester",
      "-c",
      "user.email=history@example.com",
      "commit",
      "-m",
      "Before",
    ],
    { cwd: directory, stdio: "ignore" },
  );
  writeFileSync(file, "after\n");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=History Tester",
      "-c",
      "user.email=history@example.com",
      "commit",
      "-am",
      "After",
    ],
    { cwd: directory, stdio: "ignore" },
  );
  const nested = join(directory, "nested");
  mkdirSync(nested);
  const bootstrap = await loadAppBootstrap(
    { kind: "show", ref: "HEAD", options: { mode: "unified", vcs: "git" } },
    { cwd: nested, vcsCatalog: getBundledVcsCatalog() },
  );
  bootstrap.review = Object.freeze({
    kind: "commit",
    provider: "Git",
    title: "After",
    revision: "abc1234",
    author: "history",
    authoredAt: "2026-01-01T00:00:00Z",
  });
  return { bootstrap, directory };
}

/** Settle mounted host work until a committed bootstrap observation arrives. */
async function flushUntil(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: () => boolean,
  description: string,
) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(10);
      await setup.renderOnce();
    });
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${description}.`);
}

describe("review metadata reloads", () => {
  test("the bundled review pane occupies exactly three rows only for supported metadata", async () => {
    const delegated = await createTestBootstrap();
    const ordinary = await createTestBootstrap();
    delete ordinary.bootstrap.review;

    const renderFrame = async (bootstrap: AppBootstrap) => {
      let committed = false;
      const setup = await testRender(
        <AppHost bootstrap={bootstrap} onActiveBootstrapChange={() => (committed = true)} />,
        { width: 100, height: 12 },
      );
      try {
        await flushUntil(setup, () => committed, "the review to mount");
        return setup.captureCharFrame();
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    };

    try {
      const delegatedFrame = await renderFrame(delegated.bootstrap);
      const ordinaryFrame = await renderFrame(ordinary.bootstrap);
      const firstFileRow = (frame: string) =>
        frame.split("\n").findIndex((line) => line.includes("example.txt"));
      expect(delegatedFrame).toContain("OPEN · #123 · Metadata pane");
      expect(ordinaryFrame).not.toContain("OPEN · #123 · Metadata pane");
      expect(firstFileRow(delegatedFrame)).toBe(firstFileRow(ordinaryFrame) + 3);
    } finally {
      rmSync(delegated.directory, { recursive: true, force: true });
      rmSync(ordinary.directory, { recursive: true, force: true });
    }
  });

  test("manual refresh preserves the same patch metadata and unrelated reloads clear it durably", async () => {
    const fixture = await createTestBootstrap();
    const committed: AppBootstrap[] = [];
    const broker = createTestHostClient();
    const setup = await testRender(
      <AppHost
        bootstrap={fixture.bootstrap}
        hostClient={broker.hostClient}
        onActiveBootstrapChange={(bootstrap) => committed.push(bootstrap)}
      />,
      { width: 100, height: 12 },
    );

    try {
      await flushUntil(setup, () => committed.length === 1, "the delegated review to mount");
      const initialFrame = setup.captureCharFrame();
      expect(initialFrame).toContain("OPEN · #123 · Metadata pane");
      expect(initialFrame).toContain(
        "octocat · GitHub · modem-dev/hunk · main ← feature/review-info",
      );
      expect(initialFrame.indexOf("OPEN · #123")).toBeLessThan(initialFrame.indexOf("example.txt"));

      writeTestPatch(fixture.firstPatch, "manually refreshed");
      await act(async () => setup.mockInput.typeText("r"));
      await flushUntil(setup, () => committed.length >= 2, "the manual refresh to commit");
      expect(committed.at(-1)?.review).toBe(fixture.bootstrap.review);

      await act(async () => {
        await broker.dispatchCommand({
          type: "command",
          requestId: "unrelated-patch",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "patch",
              file: fixture.secondPatch,
              options: { mode: "unified" },
            },
          },
        });
      });
      await flushUntil(setup, () => committed.length >= 3, "the unrelated review to commit");
      expect(committed.at(-1)?.review).toBeUndefined();

      // Returning to the original resource compares against the latest identity,
      // rather than resurrecting metadata retained from the initial delegated launch.
      await act(async () => {
        await broker.dispatchCommand({
          type: "command",
          requestId: "return-to-original-patch",
          command: "reload_session",
          input: {
            sessionId: "session-1",
            nextInput: {
              kind: "patch",
              file: fixture.firstPatch,
              options: { mode: "unified" },
            },
          },
        });
      });
      await flushUntil(setup, () => committed.length >= 4, "the original resource to remount");
      expect(committed.at(-1)?.review).toBeUndefined();
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("manual refresh preserves history metadata when launched from a repository subdirectory", async () => {
    const fixture = await createHistoryCommitBootstrap();
    const committed: AppBootstrap[] = [];
    const setup = await testRender(
      <AppHost
        bootstrap={fixture.bootstrap}
        onActiveBootstrapChange={(bootstrap) => committed.push(bootstrap)}
      />,
      { width: 100, height: 12 },
    );

    try {
      await flushUntil(setup, () => committed.length === 1, "the commit review to mount");
      await act(async () => setup.mockInput.typeText("r"));
      await flushUntil(setup, () => committed.length >= 2, "the commit refresh to commit");
      expect(committed.at(-1)?.review).toBe(fixture.bootstrap.review);
      expect(setup.captureCharFrame()).toContain("After");
      expect(setup.captureCharFrame()).toContain("history ·");
    } finally {
      await act(async () => setup.renderer.destroy());
      // Bun can retain the Git fixture as a child-process cwd past renderer teardown on Windows;
      // the ephemeral CI/user temp directory owns cleanup there.
      if (process.platform !== "win32") {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  test("watch refresh preserves delegated metadata for the same patch resource", async () => {
    const fixture = await createTestBootstrap({ watch: true });
    const committed: AppBootstrap[] = [];
    const watch = createWatchTestRuntime();
    const setup = await testRender(
      <AppHost
        bootstrap={fixture.bootstrap}
        onActiveBootstrapChange={(bootstrap) => committed.push(bootstrap)}
        watchRuntime={watch.runtime}
      />,
      { width: 100, height: 12 },
    );

    try {
      await flushUntil(setup, () => committed.length === 1, "the watched review to mount");
      expect(watch.sources).toHaveLength(1);
      writeTestPatch(fixture.firstPatch, "watched refresh");
      watch.setSignature("signature:changed");
      watch.emit();
      await act(async () => {
        watch.advanceBy(200);
        await Promise.resolve();
      });
      await flushUntil(setup, () => committed.length >= 2, "the watch refresh to commit");
      for (let attempt = 0; attempt < 6; attempt++) {
        await act(async () => {
          await setup.renderOnce();
          await Promise.resolve();
        });
      }

      expect(committed.at(-1)?.review).toBe(fixture.bootstrap.review);
      expect(watch.sources).toHaveLength(2);
      expect(watch.sources[0]?.closeCount).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
