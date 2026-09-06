import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestSessionRegistration,
  createTestSessionReviewFile,
  createTestSessionSnapshot,
} from "../../../../../test/helpers/session-daemon-fixtures";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import {
  SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE,
  SessionBroker,
  createSessionBrokerDaemon,
  type SessionBrokerSocketLike,
} from "@hunk/session-broker";
import { serveSessionBrokerDaemon as serveBunSessionBrokerDaemon } from "@hunk/session-broker-bun";
import { hunkSessionProtocolParsers } from "./protocolParsers";
import { isQuiescentUpgradeRefusal, SessionBrokerClient } from "./brokerClient";
import type { ResolvedSessionBrokerConfig } from "./brokerConfig";
import {
  loadOrCreateHunkSessionBrokerCredentials,
  type HunkSessionBrokerCredentials,
} from "./credentials";
import { serveSessionBrokerDaemon as serveHunkSessionBrokerDaemon } from "./brokerServer";
import { createHttpHunkSessionCliClient } from "../agent/cliClient";
import { HUNK_DAEMON_UPGRADE_WAIT_MESSAGE } from "../client/capabilities";
import { resolveSessionBrokerRuntimePaths } from "./brokerLauncher";
import { DeterministicLifecycleClockTest } from "../../../../../test/helpers/lifecycleClockTest";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalDisable = process.env.HUNK_MCP_DISABLE;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const originalConsoleError = console.error;
const nativeSetTimeoutTest = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeoutTest = globalThis.clearTimeout.bind(globalThis);
let restoreWebSocketObserverTest: (() => void) | null = null;

type DeepPartialTest<T> = T extends object ? { [Key in keyof T]?: DeepPartialTest<T[Key]> } : T;

interface SessionBrokerConnectionTestDouble {
  options: {
    resolveClose?: (...args: unknown[]) => { reconnect?: boolean };
  };
  start(): void;
  stop(): void;
  updateSnapshot(snapshot: ReturnType<typeof createSnapshot>): void;
  replaceSession(
    registration: ReturnType<typeof createRegistration>,
    snapshot: ReturnType<typeof createSnapshot>,
  ): void;
}

interface SessionBrokerClientTestAccess {
  connection: Partial<SessionBrokerConnectionTestDouble> | null;
  credentials: DeepPartialTest<HunkSessionBrokerCredentials> | null;
  waitingForIncumbentExit: boolean;
  restartIncompatibleDaemon?: unknown;
  connect(config: ResolvedSessionBrokerConfig): void;
  ensureDaemonAndConnect(attempt?: unknown): Promise<void>;
  ensureDaemonAvailable(config: ResolvedSessionBrokerConfig): Promise<void>;
  loadCredentials(): Promise<HunkSessionBrokerCredentials>;
  scheduleReconnect(delayMs?: number): void;
}

/** Access lifecycle internals through one explicit, structurally checked test seam. */
function clientTestAccess(client: SessionBrokerClient) {
  return client as unknown as SessionBrokerClientTestAccess;
}

function createRegistration() {
  return createTestSessionRegistration({
    cwd: process.cwd(),
    inputKind: "diff",
    pid: process.pid,
    repoRoot: process.cwd(),
    sourceLabel: "before.ts -> after.ts",
    title: "before.ts ↔ after.ts",
    files: [createTestSessionReviewFile({ path: "after.ts" })],
  });
}

function createSnapshot() {
  return createTestSessionSnapshot({
    selectedFilePath: "after.ts",
    showAgentNotes: true,
  });
}

async function waitUntil(
  label: string,
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

/** Capture broker warnings while afterEach owns restoration of the process-wide console. */
function captureBrokerWarningsTest() {
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(" "));
  };
  return messages;
}

/** Await one lifecycle promise while turning a lost wakeup into a bounded test failure. */
async function settleWithinTestTimeout<T>(promise: PromiseLike<T> | T, timeoutMs = 500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timeout = nativeSetTimeoutTest(
          () => reject(new Error(`Promise did not settle within ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) nativeClearTimeoutTest(timeout);
  }
}

/** Create a manually released promise for startup race characterization. */
function createDeferredTest<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Observe WebSocket construction without opening a network connection. */
function installWebSocketObserverTest(
  throwOnAttempt?: number,
  onConstruct?: (attempt: number) => void,
) {
  if (restoreWebSocketObserverTest) {
    throw new Error("A WebSocket observer is already installed.");
  }
  const OriginalWebSocket = globalThis.WebSocket;
  const sockets: Array<{
    sent: string[];
    emitOpen: () => void;
    emitClose: (code?: number, reason?: string) => void;
  }> = [];
  let constructionAttempts = 0;

  class ObservedWebSocketTest implements SessionBrokerSocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(_url: string) {
      constructionAttempts += 1;
      onConstruct?.(constructionAttempts);
      if (constructionAttempts === throwOnAttempt) throw new Error("socket factory exploded");
      sockets.push(this);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close(code = 1000, reason = "") {
      this.emitClose(code, reason);
    }

    emitOpen() {
      this.readyState = 1;
      this.onopen?.();
    }

    emitClose(code = 1000, reason = "") {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }

  let restored = false;
  const restoreTest = () => {
    if (restored) return;
    restored = true;
    globalThis.WebSocket = OriginalWebSocket;
    if (restoreWebSocketObserverTest === restoreTest) restoreWebSocketObserverTest = null;
  };
  // Register cleanup before replacing the host constructor so later setup failures cannot leak it.
  restoreWebSocketObserverTest = restoreTest;
  globalThis.WebSocket = ObservedWebSocketTest as unknown as typeof WebSocket;
  return {
    sockets,
    constructionAttemptsTest: () => constructionAttempts,
    restoreTest,
  };
}

/** Supply inert credentials so startup tests can exercise the real connection ownership path. */
function prepareDirectConnectTest(client: SessionBrokerClient) {
  clientTestAccess(client).credentials = {
    producer: {},
    daemonIdentity: { keyId: "daemon-key-test" },
    daemonPublicKey: {},
  };
  return {
    host: "127.0.0.1",
    port: 47657,
    httpOrigin: "http://127.0.0.1:47657",
    wsOrigin: "ws://127.0.0.1:47657",
  };
}

afterEach(() => {
  restoreWebSocketObserverTest?.();

  if (originalHost === undefined) {
    delete process.env.HUNK_MCP_HOST;
  } else {
    process.env.HUNK_MCP_HOST = originalHost;
  }

  if (originalPort === undefined) {
    delete process.env.HUNK_MCP_PORT;
  } else {
    process.env.HUNK_MCP_PORT = originalPort;
  }

  if (originalDisable === undefined) {
    delete process.env.HUNK_MCP_DISABLE;
  } else {
    process.env.HUNK_MCP_DISABLE = originalDisable;
  }

  if (originalUnsafeRemote === undefined) {
    delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
  } else {
    process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE = originalUnsafeRemote;
  }

  if (originalRuntimeDir === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  }

  console.error = originalConsoleError;
});

describe("Hunk session daemon client", () => {
  test("only treats exact pre-authentication compatibility closes as quiescent refusals", () => {
    const reason = "Session broker authentication required; upgrade Hunk.";
    expect(isQuiescentUpgradeRefusal({ code: 1008, reason, authenticated: false })).toBe(true);
    expect(
      isQuiescentUpgradeRefusal({
        code: 1008,
        reason: "Malformed session broker protocol.",
        authenticated: false,
      }),
    ).toBe(true);
    expect(isQuiescentUpgradeRefusal({ code: 1008, reason, authenticated: true })).toBe(false);
    expect(isQuiescentUpgradeRefusal({ code: 1006, reason, authenticated: false })).toBe(false);
    expect(
      isQuiescentUpgradeRefusal({
        code: 1008,
        reason: "Session broker authentication failed.",
        authenticated: false,
      }),
    ).toBe(false);
  });

  test("keeps its previous registration when the live connection rejects replacement", () => {
    const registration = createRegistration();
    const client = new SessionBrokerClient(registration, createSnapshot());
    clientTestAccess(client).connection = {
      replaceSession() {
        throw new Error("connection exploded");
      },
    };

    expect(() =>
      client.replaceSession(
        { ...registration, sessionId: "replacement-session" },
        createSnapshot(),
      ),
    ).toThrow("connection exploded");
    expect(client.getRegistration()).toBe(registration);
  });

  test("logs one actionable warning when the session daemon is configured for a non-loopback host without opt-in", async () => {
    process.env.HUNK_MCP_HOST = "0.0.0.0";
    process.env.HUNK_MCP_PORT = "47657";
    delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
    delete process.env.HUNK_MCP_DISABLE;

    const messages = captureBrokerWarningsTest();

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());

    try {
      client.start();
      await waitUntil("non-loopback session-daemon warning", () => messages.length === 1);

      expect(messages[0]).toContain(
        "[session:broker] Session broker refuses to bind 0.0.0.0:47657 because it is local-only by default.",
      );
      expect(messages[0]).toContain("HUNK_MCP_UNSAFE_ALLOW_REMOTE=1");
    } finally {
      client.stop();
    }
  }, 10_000);

  test("does not retain the legacy PID-based incompatible-daemon replacement path", () => {
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    expect(clientTestAccess(client).restartIncompatibleDaemon).toBeUndefined();
    client.stop();
  });

  test("logs one actionable warning when a refreshed daemon rejects an older Hunk window", async () => {
    const listener = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          pid: process.pid,
          sessions: 0,
          pendingCommands: 0,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => listener.close(() => resolve()));

    let websocketOpens = 0;
    const server = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          return Response.json({
            ok: true,
            pid: process.pid,
            sessions: 0,
            pendingCommands: 0,
          });
        }

        if (url.pathname === "/session-api/capabilities") {
          return Response.json({
            version: HUNK_SESSION_API_VERSION,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            actions: ["list"],
          });
        }

        if (url.pathname === "/session") {
          if (bunServer.upgrade(request)) {
            return undefined;
          }

          return new Response("Expected websocket upgrade.", { status: 426 });
        }

        return new Response("Not found.", { status: 404 });
      },
      websocket: {
        open(socket) {
          websocketOpens += 1;
          setTimeout(
            () => socket.close(1008, "Session broker authentication required; upgrade Hunk."),
            20,
          );
        },
        message() {},
      },
    });

    const messages = captureBrokerWarningsTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 10,
    });
    const skewedRegistration = createRegistration();
    skewedRegistration.sessionId = "session-skewed";
    const skewedClient = new SessionBrokerClient(skewedRegistration, createSnapshot(), {
      reconnectDelayMs: 17,
    });

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`);
          if (health.ok) {
            break;
          }
        } catch {
          // Give the local websocket server one brief moment to finish binding.
        }

        await Bun.sleep(25);
      }

      const credentials = await loadOrCreateHunkSessionBrokerCredentials();
      const config = {
        host: "127.0.0.1",
        port,
        httpOrigin: `http://127.0.0.1:${port}`,
        wsOrigin: `ws://127.0.0.1:${port}`,
      };
      clientTestAccess(client).credentials = credentials;
      clientTestAccess(client).connect(config);
      await Bun.sleep(7);
      clientTestAccess(skewedClient).credentials = credentials;
      clientTestAccess(skewedClient).connect(config);
      await waitUntil("both incompatible session warnings", () => messages.length === 2);
      expect(messages.every((message) => message.includes("Close older Hunk windows"))).toBe(true);
      await Bun.sleep(60);
      expect(websocketOpens).toBe(2);
      expect(clientTestAccess(client).waitingForIncumbentExit).toBe(true);
      expect(clientTestAccess(skewedClient).waitingForIncumbentExit).toBe(true);
    } finally {
      client.stop();
      skewedClient.stop();
      server.stop(true);
    }
  }, 10_000);

  test("authenticates after a successor becomes healthy before the waiter observes absence", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-missed-daemon-absence-"));
    let helloAttempts = 0;
    const incumbentDaemon = createSessionBrokerDaemon({
      broker: new SessionBroker({
        protocolParsers: hunkSessionProtocolParsers,
      }),
      appId: "dev.hunk",
      appRevision: HUNK_SESSION_DAEMON_VERSION,
      // This fixture rejects before endpoint binding participates in authentication. Let Bun own
      // ephemeral-port selection so Windows never has to release and immediately rebind a probe.
      producerEndpoint: "ws://127.0.0.1:0/session",
      idleTimeoutMs: 0,
      helloAuthenticator: {
        async issueChallenge() {
          helloAttempts += 1;
          throw new Error("incompatible application revision");
        },
        async completeCallerHello() {
          throw new Error("not used");
        },
        async completeProducerHello() {
          throw new Error("not used");
        },
      },
    });
    const incumbent = serveBunSessionBrokerDaemon({
      daemon: incumbentDaemon,
      hostname: "127.0.0.1",
      port: 0,
    });
    const port = incumbent.port;
    if (!port) throw new Error("Expected Bun to select an ephemeral incumbent port.");
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);
    void incumbentDaemon.stopped.then(() => incumbent.stop(true));
    let successor: Awaited<ReturnType<typeof serveHunkSessionBrokerDaemon>> | null = null;
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      // Leave enough time to replace the listener before this client polls again, preserving the
      // missed-absence race this test exercises even when Windows delays port reuse.
      reconnectDelayMs: 2_000,
    });
    const metadataPath = resolveSessionBrokerRuntimePaths({
      host: "127.0.0.1",
      port,
    }).metadataPath;
    mkdirSync(join(metadataPath, ".."), { recursive: true });
    const writeMetadata = (pid: number) =>
      writeFileSync(
        metadataPath,
        JSON.stringify({
          pid,
          host: "127.0.0.1",
          port,
          command: "/fixture/hunk",
          args: ["daemon", "serve"],
          launchedAt: new Date(pid).toISOString(),
          launchedByPid: pid,
          launchCwd: "/fixture",
        }),
      );
    writeMetadata(100);

    try {
      await client.start();
      const retainedConnection = clientTestAccess(client).connection;
      await waitUntil("incompatible signed hello", () => helloAttempts === 1);

      incumbentDaemon.shutdown();
      await incumbentDaemon.stopped;
      incumbent.stop(true);
      await incumbent.stopped;
      // Windows may delay reuse briefly after Bun closes a listener. The production outer retry
      // handles that interval; this fixture waits inside the client's longer reconnect window.
      if (process.platform === "win32") await Bun.sleep(1_000);
      successor = await serveHunkSessionBrokerDaemon({ idleTimeoutMs: 0 });
      writeMetadata(200);

      await waitUntil(
        "registration after missed endpoint absence",
        async () => {
          try {
            return (
              (
                await createHttpHunkSessionCliClient({
                  timeoutMs: 250,
                }).listSessions()
              ).length === 1
            );
          } catch {
            return false;
          }
        },
        5_000,
        25,
      );
      expect(helloAttempts).toBe(1);
      expect(clientTestAccess(client).connection).toBe(retainedConnection);
    } finally {
      client.stop();
      incumbentDaemon.shutdown();
      incumbent.stop(true);
      successor?.stop(true);
      if (successor) await successor.stopped;
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("waits out an incompatible incumbent and registers on its successor with one connection", async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "hunk-quiescent-upgrade-"));
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    let helloAttempts = 0;
    const incumbentDaemon = createSessionBrokerDaemon({
      broker: new SessionBroker({
        protocolParsers: hunkSessionProtocolParsers,
      }),
      appId: "dev.hunk",
      appRevision: HUNK_SESSION_DAEMON_VERSION,
      producerEndpoint: `ws://127.0.0.1:${port}/session`,
      idleTimeoutMs: 0,
      helloAuthenticator: {
        async issueChallenge() {
          helloAttempts += 1;
          throw new Error("incompatible application revision");
        },
        async completeCallerHello() {
          throw new Error("not used");
        },
        async completeProducerHello() {
          throw new Error("not used");
        },
      },
    });
    const incumbent = serveBunSessionBrokerDaemon({
      daemon: incumbentDaemon,
      hostname: "127.0.0.1",
      port,
    });
    void incumbentDaemon.stopped.then(() => incumbent.stop(true));
    let successor: Awaited<ReturnType<typeof serveHunkSessionBrokerDaemon>> | null = null;
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 10,
    });
    clientTestAccess(client).ensureDaemonAvailable = async () => {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        // Launch the successor after the test retires the incompatible incumbent.
      }
      successor ??= await serveHunkSessionBrokerDaemon({ idleTimeoutMs: 0 });
    };

    try {
      await client.start();
      const retainedConnection = clientTestAccess(client).connection;
      await waitUntil("first incompatible websocket", () => helloAttempts === 1);
      await Bun.sleep(35);
      expect(helloAttempts).toBe(1);

      incumbentDaemon.shutdown();
      await incumbentDaemon.stopped;
      incumbent.stop(true);
      await incumbent.stopped;

      await waitUntil(
        "successor session registration",
        async () => {
          try {
            return (
              (
                await createHttpHunkSessionCliClient({
                  timeoutMs: 250,
                }).listSessions()
              ).length === 1
            );
          } catch {
            return false;
          }
        },
        5_000,
        50,
      );
      expect(clientTestAccess(client).connection).toBe(retainedConnection);

      const firstSuccessor = successor as unknown as Awaited<
        ReturnType<typeof serveHunkSessionBrokerDaemon>
      >;
      firstSuccessor.stop(true);
      await firstSuccessor.stopped;
      successor = null;
      await waitUntil(
        "registration after a second daemon generation",
        async () => {
          try {
            return (
              (
                await createHttpHunkSessionCliClient({
                  timeoutMs: 250,
                }).listSessions()
              ).length === 1
            );
          } catch {
            return false;
          }
        },
        5_000,
        50,
      );
      expect(clientTestAccess(client).connection).toBe(retainedConnection);
    } finally {
      client.stop();
      incumbentDaemon.shutdown();
      incumbent.stop(true);
      const runningSuccessor = successor as Awaited<
        ReturnType<typeof serveHunkSessionBrokerDaemon>
      > | null;
      runningSuccessor?.stop(true);
      if (runningSuccessor) await runningSuccessor.stopped;
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("threads only the fixed lifecycle defect message through the generic connection", () => {
    const webSockets = installWebSocketObserverTest();
    const defectMessages: string[] = [];
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      onDefect: (message) => defectMessages.push(message),
    });
    const config = prepareDirectConnectTest(client);

    try {
      clientTestAccess(client).connect(config);
      const connection = clientTestAccess(client).connection;
      if (!connection?.options) throw new Error("Expected a live connection test owner.");
      connection.options.resolveClose = () => {
        throw new Error(`credential-${crypto.randomUUID()}`);
      };
      expect(() => webSockets.sockets[0]!.emitClose()).not.toThrow();
      expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  test("threads its lifecycle clock into the generic connection", () => {
    const clock = new DeterministicLifecycleClockTest();
    const webSockets = installWebSocketObserverTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      lifecycleClock: clock,
    });
    const config = prepareDirectConnectTest(client);

    try {
      clientTestAccess(client).connect(config);
      expect(webSockets.sockets).toHaveLength(1);
      expect(clock.pendingCountTest()).toBe(1);
      client.stop();
      client.stop();
      expect(clock.pendingCountTest()).toBe(0);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  test("repeated start after success settles while retaining one socket generation", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const webSockets = installWebSocketObserverTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const config = prepareDirectConnectTest(client);
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      clientTestAccess(client).connect(config);
    };

    try {
      await settleWithinTestTimeout(client.start());
      expect(webSockets.sockets).toHaveLength(1);

      await settleWithinTestTimeout(client.start());
      expect(webSockets.sockets).toHaveLength(1);
      expect(webSockets.constructionAttemptsTest()).toBe(1);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  test("concurrent starts share one settlement and perform one startup attempt", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const webSockets = installWebSocketObserverTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const config = prepareDirectConnectTest(client);
    const gate = createDeferredTest();
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      await gate.promise;
      clientTestAccess(client).connect(config);
    };

    try {
      const first = client.start();
      const second = client.start();
      expect(attempts).toBe(1);
      expect(webSockets.sockets).toHaveLength(0);

      gate.resolve();
      await settleWithinTestTimeout(Promise.all([first, second]));
      expect(attempts).toBe(1);
      expect(webSockets.sockets).toHaveLength(1);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  test("manual start during automatic retry runs now without moving the retry deadline", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const clock = new DeterministicLifecycleClockTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    const messages = captureBrokerWarningsTest();
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("startup unavailable");
    };

    try {
      await settleWithinTestTimeout(client.start());
      expect(attempts).toBe(1);
      expect(messages).toEqual(["[session:broker] startup unavailable"]);
      expect(clock.pendingCountTest()).toBe(1);

      clock.advanceByTest(10);
      await settleWithinTestTimeout(client.start());
      expect(attempts).toBe(2);
      expect(clock.pendingCountTest()).toBe(1);

      clock.advanceByTest(19);
      await Promise.resolve();
      expect(attempts).toBe(2);

      clock.advanceByTest(1);
      await Promise.resolve();
      expect(attempts).toBe(3);
      expect(clock.pendingCountTest()).toBe(0);
    } finally {
      client.stop();
    }
  });

  test("a retry deadline firing during an active attempt consumes that retry and coalesces", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const clock = new DeterministicLifecycleClockTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    const messages = captureBrokerWarningsTest();
    const activeAttempt = createDeferredTest();
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("initial startup unavailable");
      if (attempts === 2) await activeAttempt.promise;
    };

    try {
      await settleWithinTestTimeout(client.start());
      clock.advanceByTest(10);
      const manualStartup = client.start();
      expect(attempts).toBe(2);
      expect(clock.pendingCountTest()).toBe(1);

      clock.advanceByTest(20);
      expect(attempts).toBe(2);
      expect(clock.pendingCountTest()).toBe(0);
      const joinedStartup = client.start();
      expect(attempts).toBe(2);

      activeAttempt.reject(new Error("active startup unavailable"));
      await settleWithinTestTimeout(Promise.all([manualStartup, joinedStartup]));
      expect(messages).toEqual([
        "[session:broker] initial startup unavailable",
        "[session:broker] active startup unavailable",
      ]);
      expect(clock.pendingCountTest()).toBe(1);
    } finally {
      client.stop();
    }
  });

  test("a failed manual attempt retains the original automatic retry without duplicating it", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const clock = new DeterministicLifecycleClockTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    const messages = captureBrokerWarningsTest();
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("initial startup unavailable");
      if (attempts === 2) throw new Error("manual startup unavailable");
    };

    try {
      await settleWithinTestTimeout(client.start());
      expect(clock.pendingCountTest()).toBe(1);

      clock.advanceByTest(10);
      await settleWithinTestTimeout(client.start());
      expect(attempts).toBe(2);
      expect(messages).toEqual([
        "[session:broker] initial startup unavailable",
        "[session:broker] manual startup unavailable",
      ]);
      expect(clock.pendingCountTest()).toBe(1);

      clock.advanceByTest(19);
      await Promise.resolve();
      expect(attempts).toBe(2);
      clock.advanceByTest(1);
      await Promise.resolve();
      expect(attempts).toBe(3);
      expect(clock.pendingCountTest()).toBe(0);
    } finally {
      client.stop();
    }
  });

  test("a warning-side stop is terminal and clears the newly owned retry", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const clock = new DeterministicLifecycleClockTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      throw new Error("startup unavailable");
    };
    console.error = () => client.stop();

    try {
      await settleWithinTestTimeout(client.start());
      expect(attempts).toBe(1);
      expect(clock.pendingCountTest()).toBe(0);

      clock.advanceByTest(30);
      await settleWithinTestTimeout(client.start());
      expect(attempts).toBe(1);
      expect(clock.pendingCountTest()).toBe(0);
    } finally {
      client.stop();
    }
  });

  test("repeated stop clears a retry retained by an active manual attempt and fences its failure", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const clock = new DeterministicLifecycleClockTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    const messages = captureBrokerWarningsTest();
    const activeAttempt = createDeferredTest();
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("initial startup unavailable");
      await activeAttempt.promise;
      throw new Error("late manual startup failure");
    };

    try {
      await settleWithinTestTimeout(client.start());
      const manualStartup = client.start();
      expect(attempts).toBe(2);
      expect(clock.pendingCountTest()).toBe(1);

      client.stop();
      client.stop();
      expect(clock.pendingCountTest()).toBe(0);
      clock.advanceByTest(30);
      expect(attempts).toBe(2);

      activeAttempt.resolve();
      await settleWithinTestTimeout(manualStartup);
      expect(messages).toEqual(["[session:broker] initial startup unavailable"]);
      expect(clock.pendingCountTest()).toBe(0);
      await client.start();
      expect(attempts).toBe(2);
    } finally {
      client.stop();
    }
  });

  test("creates a fresh socket after synchronous socket construction fails", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const webSockets = installWebSocketObserverTest(1);
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 10_000,
    });
    const config = prepareDirectConnectTest(client);
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      clientTestAccess(client).connect(config);
    };

    try {
      await settleWithinTestTimeout(client.start());
      await settleWithinTestTimeout(client.start());
      expect(webSockets.constructionAttemptsTest()).toBe(2);
      expect(webSockets.sockets).toHaveLength(1);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  test("preserves a reentrant replacement and the original synchronous construction failure", () => {
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const config = prepareDirectConnectTest(client);
    const startupFailure = { source: "socket construction" };
    const cleanupFailure = new Error("connection cleanup exploded");
    const snapshots: ReturnType<typeof createSnapshot>[] = [];
    let failedConnectionStops = 0;
    let replacementStops = 0;
    const replacement = {
      updateSnapshot(snapshot: ReturnType<typeof createSnapshot>) {
        snapshots.push(snapshot);
      },
      stop() {
        replacementStops += 1;
      },
    };
    const webSockets = installWebSocketObserverTest(undefined, () => {
      const failedConnection = clientTestAccess(client).connection;
      if (!failedConnection) throw new Error("Expected the failed connection to be published.");
      failedConnection.stop = () => {
        failedConnectionStops += 1;
        throw cleanupFailure;
      };
      clientTestAccess(client).connection = replacement;
      throw startupFailure;
    });

    let thrown: unknown;
    try {
      clientTestAccess(client).connect(config);
    } catch (error) {
      thrown = error;
    }

    try {
      expect(thrown).toBe(startupFailure);
      expect(failedConnectionStops).toBe(1);
      const nextSnapshot = createSnapshot();
      client.updateSnapshot(nextSnapshot);
      expect(snapshots).toEqual([nextSnapshot]);
      client.stop();
      expect(replacementStops).toBe(1);
    } finally {
      client.stop();
      webSockets.restoreTest();
    }
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`stop fences late credential ${outcome} without assignment, warning, or retry`, async () => {
      delete process.env.HUNK_MCP_DISABLE;
      const clock = new DeterministicLifecycleClockTest();
      const messages: string[] = [];
      console.error = (...args: unknown[]) => {
        messages.push(args.map((value) => String(value)).join(" "));
      };
      const credentials = createDeferredTest<any>();
      const credentialLoadStarted = createDeferredTest();
      const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
        reconnectDelayMs: 30,
        lifecycleClock: clock,
      });
      clientTestAccess(client).ensureDaemonAvailable = async () => {};
      clientTestAccess(client).loadCredentials = async () => {
        credentialLoadStarted.resolve();
        return credentials.promise;
      };

      const startup = client.start();
      await settleWithinTestTimeout(credentialLoadStarted.promise);
      client.stop();
      if (outcome === "resolve") {
        credentials.resolve({ source: "late credentials" });
      } else {
        credentials.reject(new Error("late credential failure"));
      }
      await settleWithinTestTimeout(startup);

      expect(clientTestAccess(client).credentials).toBeNull();
      expect(messages).toEqual([]);
      expect(clock.pendingCountTest()).toBe(0);
    });
  }

  test("a reentrant stop during initial health remains terminal after settlement", async () => {
    delete process.env.HUNK_MCP_DISABLE;
    const nativeFetch = globalThis.fetch;
    const webSockets = installWebSocketObserverTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    let healthChecks = 0;
    globalThis.fetch = (async () => {
      healthChecks += 1;
      client.stop();
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      await settleWithinTestTimeout(client.start());
      await settleWithinTestTimeout(client.start());
      expect(healthChecks).toBe(1);
      expect(webSockets.constructionAttemptsTest()).toBe(0);
    } finally {
      client.stop();
      globalThis.fetch = nativeFetch;
      webSockets.restoreTest();
    }
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`stop fences a late startup ${outcome} without warning, retry, or socket mutation`, async () => {
      delete process.env.HUNK_MCP_DISABLE;
      const clock = new DeterministicLifecycleClockTest();
      const webSockets = installWebSocketObserverTest();
      const messages = captureBrokerWarningsTest();
      const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
        reconnectDelayMs: 30,
        lifecycleClock: clock,
      });
      const config = prepareDirectConnectTest(client);
      const gate = createDeferredTest();
      clientTestAccess(client).ensureDaemonAndConnect = async () => {
        await gate.promise;
        if (outcome === "reject") throw new Error("late startup failure");
        clientTestAccess(client).connect(config);
      };

      try {
        const startup = client.start();
        client.stop();
        gate.resolve();
        await settleWithinTestTimeout(startup);
        expect(messages).toEqual([]);
        expect(webSockets.constructionAttemptsTest()).toBe(0);
        expect(clock.pendingCountTest()).toBe(0);
      } finally {
        client.stop();
        webSockets.restoreTest();
      }
    });
  }

  for (const authority of ["stop", "replacement"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      test(`${authority} fences late incumbent health ${outcome} before reconnect mutation`, async () => {
        const nativeFetch = globalThis.fetch;
        const clock = new DeterministicLifecycleClockTest();
        const webSockets = installWebSocketObserverTest();
        const fetchStarted = createDeferredTest();
        const fetchGate = createDeferredTest();
        const messages: string[] = [];
        console.error = (...args: unknown[]) => {
          messages.push(args.map((value) => String(value)).join(" "));
        };
        globalThis.fetch = (async () => {
          fetchStarted.resolve();
          await fetchGate.promise;
          if (outcome === "reject") throw new Error("late health failure");
          return new Response("unavailable", { status: 503 });
        }) as unknown as typeof fetch;
        const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
          reconnectDelayMs: 10,
          lifecycleClock: clock,
        });
        const config = prepareDirectConnectTest(client);

        try {
          clientTestAccess(client).connect(config);
          webSockets.sockets[0]!.emitClose(
            1008,
            "Session broker authentication required; upgrade Hunk.",
          );
          expect(clientTestAccess(client).waitingForIncumbentExit).toBe(true);
          clock.advanceByTest(10);
          await settleWithinTestTimeout(fetchStarted.promise);

          if (authority === "stop") {
            client.stop();
          } else {
            clientTestAccess(client).connection!.start!();
            expect(webSockets.sockets).toHaveLength(2);
          }
          fetchGate.resolve();
          await clock.flushMicrotasksTest();
          clock.advanceByTest(20);

          expect(clientTestAccess(client).waitingForIncumbentExit).toBe(true);
          expect(messages).toEqual([`[session:broker] ${HUNK_DAEMON_UPGRADE_WAIT_MESSAGE}`]);
          expect(webSockets.sockets).toHaveLength(authority === "stop" ? 1 : 2);
        } finally {
          client.stop();
          globalThis.fetch = nativeFetch;
          webSockets.restoreTest();
        }
      });
    }
  }

  test("retries the complete startup cycle and recovers without restarting the client", async () => {
    const messages = captureBrokerWarningsTest();
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 10,
    });
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("incumbent incompatible");
    };

    try {
      await client.start();
      await waitUntil("second complete startup attempt", () => attempts === 2);
      expect(messages).toEqual(["[session:broker] incumbent incompatible"]);
    } finally {
      client.stop();
    }
  });

  test("does no daemon work when start follows terminal stop", async () => {
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    let attempts = 0;
    clientTestAccess(client).ensureDaemonAndConnect = async () => {
      attempts += 1;
    };

    client.stop();
    await client.start();
    expect(attempts).toBe(0);
  });

  test("logs one actionable warning when a non-Hunk listener owns the session daemon port", async () => {
    const conflictingListener = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not hunk");
    });
    await new Promise<void>((resolve, reject) => {
      conflictingListener.once("error", reject);
      conflictingListener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = conflictingListener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);
    delete process.env.HUNK_MCP_DISABLE;

    const messages = captureBrokerWarningsTest();

    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      daemonStartupTimeoutMs: 100,
      reconnectDelayMs: 10_000,
    });

    try {
      await client.start();
      expect(messages).toHaveLength(1);

      await client.start();

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        `[session:broker] Session broker port 127.0.0.1:${port} is already in use by another process.`,
      );
      expect(messages[0]).toContain(
        "Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.",
      );
    } finally {
      client.stop();
      await new Promise<void>((resolve) => conflictingListener.close(() => resolve()));
    }
  }, 10_000);
});
