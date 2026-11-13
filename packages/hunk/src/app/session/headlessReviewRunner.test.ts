import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { AppBootstrap } from "../../core/bootstrap";
import { loadAppBootstrap } from "../../core/changeset/loaders";
import { STML_REFERENCE_WIDTH } from "../../core/stml/layout";
import { createEmptyExtensionLoadResult, type ExtensionLoadResult } from "../../extensions/types";
import type { SessionBrokerClient } from "../../session/broker/brokerClient";
import type { HunkSessionServerMessage, HunkSessionSnapshot } from "../../session/types";
import { createWatchTestRuntime } from "../../../../../test/helpers/watchTest";
import { ReviewProducer } from "../review/producer";
import { runHeadlessReview, type HeadlessReviewSession } from "./headlessReviewRunner";
import { createInitialSessionSnapshot, createSessionRegistration } from "./registration";
import type { ReviewSessionRuntime } from "./reviewRuntime";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** Load a one-hunk diff bootstrap with an empty extension registry. */
async function createTestHeadlessBootstrap(
  options: { watch?: boolean; pendingTrust?: string } = {},
) {
  const dir = mkdtempSync(join(process.cwd(), ".hunk-headless-runner-"));
  directories.push(dir);
  const left = join(dir, "before.ts");
  const right = join(dir, "after.ts");
  writeFileSync(left, "export const answer = 41;\n");
  writeFileSync(right, "export const answer = 42;\n");
  const bootstrap = (await loadAppBootstrap({
    kind: "diff",
    left,
    right,
    options: { experimental: true, ...(options.watch ? { watch: true } : {}) },
  })) as AppBootstrap<ExtensionLoadResult>;
  bootstrap.extensions = createEmptyExtensionLoadResult(dir);
  if (options.pendingTrust) {
    bootstrap.extensions.pendingTrustRepoRoot = options.pendingTrust;
  }
  bootstrap.startupNotices = [{ key: "test", message: "a startup notice" } as never];
  return { bootstrap, right };
}

/** Build a broker-free runtime that records snapshots and keeps the bridge it was given. */
function createTestRuntime(bootstrap: AppBootstrap) {
  const producer = new ReviewProducer({
    files: bootstrap.changeset.files,
    sourceLabel: bootstrap.changeset.sourceLabel,
  });
  const publication = producer.getPublication();
  let registration = createSessionRegistration(bootstrap, publication, bootstrap.reloadContext.cwd);
  const snapshots: HunkSessionSnapshot[] = [createInitialSessionSnapshot(bootstrap, publication)];
  let bridge: { dispatchCommand(message: HunkSessionServerMessage): Promise<unknown> } | null =
    null;
  let stopped = 0;
  const hostClient = {
    getRegistration: () => registration,
    replaceSession(next: typeof registration, snapshot: HunkSessionSnapshot) {
      registration = next;
      snapshots.push(snapshot);
    },
    updateSnapshot: (snapshot: HunkSessionSnapshot) => snapshots.push(snapshot),
    setBridge: (next: typeof bridge) => {
      bridge = next;
    },
  } as unknown as SessionBrokerClient;
  const runtime: ReviewSessionRuntime = {
    hostClient,
    reviewProducer: producer,
    stop: () => {
      stopped += 1;
    },
  };
  return {
    runtime,
    snapshots,
    dispatch: (message: HunkSessionServerMessage) => bridge!.dispatchCommand(message),
    hasBridge: () => bridge !== null,
    stopCount: () => stopped,
  };
}

/** Start a headless review with recorded output and an emitter in place of the process. */
async function startTestHeadlessReview(
  bootstrap: AppBootstrap<ExtensionLoadResult>,
  watchRuntime?: ReturnType<typeof createWatchTestRuntime>["runtime"],
) {
  const fake = createTestRuntime(bootstrap);
  const signals = new EventEmitter();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let session!: HeadlessReviewSession;
  const exited = runHeadlessReview(bootstrap, {
    createReviewRuntime: () => fake.runtime,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: { HUNK_MCP_PORT: "45555" },
    signals,
    resolveUpdateNotice: async () => ({ key: "update", message: "an update notice" }) as never,
    watchRuntime,
    onStarted: (started) => {
      session = started;
    },
  });
  await Promise.resolve();
  return { fake, signals, stdout, stderr, session, exited };
}

describe("runHeadlessReview", () => {
  test("prints only the URL on stdout and routes notices to stderr", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ pendingTrust: "/repo" });
    const { stdout, stderr, session, signals, exited } = await startTestHeadlessReview(bootstrap);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stdout).toEqual([`${session.url}\n`]);
    expect(session.url).toStartWith("http://127.0.0.1:45555/review/");
    expect(stderr.join("")).toContain("hunk: warning: a startup notice");
    expect(stderr.join("")).toContain("Repo-local extensions in /repo are not trusted");
    expect(stderr.join("")).toContain("an update notice");

    signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  test("answers bridged agent commands from the host and republishes snapshots", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { fake, session, signals, exited } = await startTestHeadlessReview(bootstrap);

    const result = await fake.dispatch({
      command: "comment",
      requestId: "r1",
      input: {
        filePath: "after.ts",
        side: "new",
        line: 1,
        summary: "Headless note",
        markup: "<b>bold</b>",
      },
    } as HunkSessionServerMessage);
    expect(result).toMatchObject({ commentId: "mcp:r1", markupWidth: STML_REFERENCE_WIDTH });
    await Promise.resolve();

    const latest = fake.snapshots.at(-1)!.state;
    expect(latest.liveCommentCount).toBe(1);
    expect(latest.noteMarkupWidth).toBe(STML_REFERENCE_WIDTH);
    expect(latest.reviewPublication?.generation).toBe(
      session.runtime.reviewProducer.getPublication().generation,
    );
    // The producer plans brokered actions against the host's store.
    expect(session.runtime.reviewProducer.getReviewState()).toBe(session.getHost().getSnapshot());

    signals.emit("SIGTERM");
    await exited;
  });

  test("shuts down in order: reloads refused, extensions retired, broker client stopped", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { fake, session, exited } = await startTestHeadlessReview(bootstrap);

    await session.shutdown();
    expect(await exited).toBe(0);
    expect(session.coordinator.isShuttingDown()).toBe(true);
    await expect(session.coordinator.reload(bootstrap.input)).rejects.toThrow("shutting down");
    expect(fake.stopCount()).toBe(1);
    expect(fake.hasBridge()).toBe(false);
  });

  test("a watch change reloads the review in place and re-attaches the producer", async () => {
    const { bootstrap, right } = await createTestHeadlessBootstrap({ watch: true });
    const watch = createWatchTestRuntime();
    const { session, signals, exited } = await startTestHeadlessReview(bootstrap, watch.runtime);
    const host = session.getHost();
    const generation = session.runtime.reviewProducer.getPublication().generation;

    writeFileSync(right, "export const answer = 42;\nexport const observed = true;\n");
    watch.setSignature("signature:1");
    watch.emit();
    watch.advanceBy(200);
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(session.getHost()).toBe(host);
    expect(session.runtime.reviewProducer.getPublication().generation).not.toBe(generation);
    expect(session.runtime.reviewProducer.getReviewState()).toBe(host.getSnapshot());
    expect(watch.sources).toHaveLength(2);
    expect(watch.sources[0]?.closeCount).toBe(1);

    signals.emit("SIGINT");
    await exited;
    expect(watch.sources[1]?.closeCount).toBe(1);
  });
});
