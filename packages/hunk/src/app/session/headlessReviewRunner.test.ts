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
import type { ReviewUrlOpener } from "./openReview";
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
  options: { watch?: boolean; pendingTrust?: string; open?: false } = {},
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
    options: {
      experimental: true,
      ...(options.watch ? { watch: true } : {}),
      ...(options.open === false ? { open: false } : {}),
    },
  })) as AppBootstrap<ExtensionLoadResult>;
  bootstrap.extensions = createEmptyExtensionLoadResult(dir);
  if (options.pendingTrust) {
    bootstrap.extensions.pendingTrustRepoRoot = options.pendingTrust;
  }
  bootstrap.startupNotices = [{ key: "test", message: "a startup notice" } as never];
  return { bootstrap, right };
}

/** Build a broker-free runtime that records snapshots and keeps the bridge it was given. */
function createTestRuntime(
  bootstrap: AppBootstrap,
  waitForRegistration: () => Promise<void> = async () => {},
) {
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
    waitForFirstRegistration: waitForRegistration,
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
  options: {
    openUrl?: ReviewUrlOpener;
    stderrIsTTY?: boolean;
    waitForRegistration?: () => Promise<void>;
    registrationTimeoutMs?: number;
  } = {},
) {
  const fake = createTestRuntime(bootstrap, options.waitForRegistration);
  const signals = new EventEmitter();
  const stdout: string[] = [];
  const stderr: string[] = [];
  // Every run injects an opener so no test starts a real browser.
  const opened: string[] = [];
  const hold = { acquired: 0, released: 0 };
  let closeOutput: (() => void) | undefined;
  let session!: HeadlessReviewSession;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const exited = runHeadlessReview(bootstrap, {
    registrationTimeoutMs: options.registrationTimeoutMs,
    holdProcess: () => {
      hold.acquired += 1;
      return () => {
        hold.released += 1;
      };
    },
    watchOutputClosed: (onClosed) => {
      closeOutput = onClosed;
      return () => {
        closeOutput = undefined;
      };
    },
    openUrl:
      options.openUrl ??
      (async (url) => {
        opened.push(url);
        return { ok: true };
      }),
    stderrIsTTY: options.stderrIsTTY ?? false,
    createReviewRuntime: () => fake.runtime,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: { HUNK_MCP_PORT: "45555" },
    signals,
    resolveUpdateNotice: async () => ({ key: "update", message: "an update notice" }) as never,
    watchRuntime,
    onStarted: (running) => {
      session = running;
      resolveStarted();
    },
  });
  // A run that fails before it starts settles `exited` instead; the test inspects that.
  await Promise.race([started, exited.catch(() => undefined)]);
  return {
    fake,
    signals,
    stdout,
    stderr,
    opened,
    session,
    exited,
    hold,
    closeOutput: () => closeOutput?.(),
    isWatchingOutput: () => closeOutput !== undefined,
  };
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

  test("opens the printed URL, fragment included, after printing it", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { stdout, opened, session, signals, exited } = await startTestHeadlessReview(bootstrap);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.url).toContain("#capability=");
    expect(opened).toEqual([session.url]);
    expect(stdout).toEqual([`${session.url}\n`]);

    signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  test("--no-open prints the URL and opens nothing", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    const { stdout, opened, session, signals, exited } = await startTestHeadlessReview(bootstrap);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stdout).toEqual([`${session.url}\n`]);
    expect(opened).toEqual([]);

    signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  test("a failed browser launch is one stderr line without the URL, and serving continues", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { fake, stderr, session, signals, exited } = await startTestHeadlessReview(
      bootstrap,
      undefined,
      { openUrl: async () => ({ ok: false, reason: "Could not open a browser with xdg-open." }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failureLines = stderr.filter((line) => line.includes("Could not open a browser"));
    expect(failureLines).toEqual([
      "hunk: warning: Could not open a browser with xdg-open. Open the URL above in a browser instead.\n",
    ]);
    expect(stderr.join("")).not.toContain(session.url.split("#")[1]!);
    expect(fake.hasBridge()).toBe(true);

    signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  test("tells a person at a terminal that the review opened and how to stop it", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const tty = await startTestHeadlessReview(bootstrap, undefined, { stderrIsTTY: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tty.stderr.filter((line) => line.includes("Ctrl+C"))).toEqual([
      "hunk: review ready in your browser. Press Ctrl+C to stop.\n",
    ]);
    tty.signals.emit("SIGINT");
    await tty.exited;

    const piped = await startTestHeadlessReview(bootstrap, undefined, { stderrIsTTY: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(piped.stderr.join("")).not.toContain("Ctrl+C");
    expect(piped.stderr.join("")).not.toContain("review ready");
    piped.signals.emit("SIGINT");
    await piped.exited;
  });

  test("with --no-open, tells a person at a terminal to open the URL", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    const tty = await startTestHeadlessReview(bootstrap, undefined, { stderrIsTTY: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tty.stderr).toContain("hunk: open the URL above in a browser. Press Ctrl+C to stop.\n");
    expect(tty.stderr.join("")).not.toContain("review ready");
    tty.signals.emit("SIGINT");
    await tty.exited;

    const piped = await startTestHeadlessReview(bootstrap, undefined, { stderrIsTTY: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(piped.stderr.join("")).not.toContain("open the URL above");
    piped.signals.emit("SIGINT");
    await piped.exited;
  });

  test("a failed launch at a terminal folds the stop hint into its one warning", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const tty = await startTestHeadlessReview(bootstrap, undefined, {
      stderrIsTTY: true,
      openUrl: async () => ({ ok: false, reason: "Could not open a browser with xdg-open." }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hints = tty.stderr.filter((line) => line.includes("Ctrl+C"));
    expect(hints).toEqual([
      "hunk: warning: Could not open a browser with xdg-open. Open the URL above in a browser instead. Press Ctrl+C to stop.\n",
    ]);
    tty.signals.emit("SIGINT");
    await tty.exited;
  });

  test("answers open_review with its URL or by opening it", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    const { fake, opened, session, signals, exited } = await startTestHeadlessReview(bootstrap);

    const openMessage = (requestId: string, open: boolean) =>
      ({ command: "open_review", requestId, input: { open } }) as HunkSessionServerMessage;

    expect(await fake.dispatch(openMessage("o1", false))).toEqual({
      opened: false,
      url: session.url,
    });
    expect(opened).toEqual([]);
    expect(await fake.dispatch(openMessage("o2", true))).toEqual({ opened: true });
    expect(opened).toEqual([session.url]);

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

  test("prints the URL only once a daemon has accepted the session", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    let accept!: () => void;
    const registered = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const exitedEarly = { value: false };
    let session: HeadlessReviewSession | undefined;
    const fake = createTestRuntime(bootstrap, () => registered);
    const stdout: string[] = [];
    const signals = new EventEmitter();
    const exited = runHeadlessReview(bootstrap, {
      createReviewRuntime: () => fake.runtime,
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      env: { HUNK_MCP_PORT: "45555" },
      signals,
      stderrIsTTY: false,
      holdProcess: () => () => {},
      watchOutputClosed: () => () => {},
      resolveUpdateNotice: async () => null,
      onStarted: (running) => {
        session = running;
      },
    }).finally(() => {
      exitedEarly.value = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stdout).toEqual([]);
    expect(session).toBeUndefined();

    accept();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stdout).toEqual([`${session!.url}\n`]);
    expect(exitedEarly.value).toBe(false);

    signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  test("exits with a user error naming the port, and no URL, when registration fails", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    const conflict = new Error(
      "Session broker port 127.0.0.1:45555 is already in use by another process. Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.",
    );
    const review = await startTestHeadlessReview(bootstrap, undefined, {
      waitForRegistration: async () => {
        throw conflict;
      },
    });

    const error = await review.exited.then(
      () => null,
      (failure: unknown) => failure as Error,
    );
    expect(error?.name).toBe("HunkUserError");
    expect(error?.message).toBe(
      `could not serve this review through the session daemon on 127.0.0.1:45555. ${conflict.message}`,
    );
    expect(review.stdout).toEqual([]);
    expect(review.fake.stopCount()).toBe(1);
    expect(review.fake.hasBridge()).toBe(false);
    expect(review.hold.acquired).toBe(0);
  });

  test("gives up on a daemon that never answers within the registration bound", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap({ open: false });
    const review = await startTestHeadlessReview(bootstrap, undefined, {
      waitForRegistration: () => new Promise<void>(() => {}),
      registrationTimeoutMs: 20,
    });

    await expect(review.exited).rejects.toThrow(
      "could not serve this review through the session daemon on 127.0.0.1:45555. No session daemon accepted it within 1 seconds. Stop whatever else holds that port, or set HUNK_MCP_PORT to a different loopback port.",
    );
    expect(review.stdout).toEqual([]);
    expect(review.fake.stopCount()).toBe(1);
  });

  // The broker client's reconnect timers are unref'd. Without a held handle, a review whose
  // daemon went away had nothing referenced left and Bun busy-polled at 100% CPU until killed.
  test("holds the process open while serving and releases it once shut down", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { hold, signals, exited } = await startTestHeadlessReview(bootstrap);

    expect(hold).toEqual({ acquired: 1, released: 0 });

    signals.emit("SIGTERM");
    expect(await exited).toBe(0);
    expect(hold).toEqual({ acquired: 1, released: 1 });
  });

  test("an output with no reader left shuts the review down in order", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const review = await startTestHeadlessReview(bootstrap);
    expect(review.isWatchingOutput()).toBe(true);

    review.closeOutput();
    expect(await review.exited).toBe(0);
    expect(review.session.coordinator.isShuttingDown()).toBe(true);
    expect(review.fake.stopCount()).toBe(1);
    expect(review.hold.released).toBe(1);
    expect(review.isWatchingOutput()).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a closed terminal's SIGHUP shuts down", async () => {
    const { bootstrap } = await createTestHeadlessBootstrap();
    const { fake, signals, exited } = await startTestHeadlessReview(bootstrap);

    signals.emit("SIGHUP");
    expect(await exited).toBe(0);
    expect(fake.stopCount()).toBe(1);
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
