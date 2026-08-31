import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestSessionRegistration,
  createTestSessionReviewFile,
  createTestSessionSnapshot,
} from "../../../test/helpers/session-daemon-fixtures";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon as serveBunSessionBrokerDaemon } from "@hunk/session-broker-bun";
import { hunkSessionProtocolParsers } from "./protocolParsers";
import { isQuiescentUpgradeRefusal, SessionBrokerClient } from "./brokerClient";
import { loadOrCreateHunkSessionBrokerCredentials } from "./credentials";
import { serveSessionBrokerDaemon as serveHunkSessionBrokerDaemon } from "./brokerServer";
import { createHttpHunkSessionCliClient } from "../agent/cliClient";
import { resolveSessionBrokerRuntimePaths } from "./brokerLauncher";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalDisable = process.env.HUNK_MCP_DISABLE;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const originalConsoleError = console.error;

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

afterEach(() => {
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
    (client as any).connection = {
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

    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map((value) => String(value)).join(" "));
    };

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
    expect((client as any).restartIncompatibleDaemon).toBeUndefined();
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

    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map((value) => String(value)).join(" "));
    };
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
      (client as any).credentials = credentials;
      (client as any).connect(config);
      await Bun.sleep(7);
      (skewedClient as any).credentials = credentials;
      (skewedClient as any).connect(config);
      await waitUntil("both incompatible session warnings", () => messages.length === 2);
      expect(messages.every((message) => message.includes("Close older Hunk windows"))).toBe(true);
      await Bun.sleep(60);
      expect(websocketOpens).toBe(2);
      expect((client as any).waitingForIncumbentExit).toBe(true);
      expect((skewedClient as any).waitingForIncumbentExit).toBe(true);
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
      const retainedConnection = (client as any).connection;
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
      expect((client as any).connection).toBe(retainedConnection);
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
      idleTimeoutMs: 150,
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
    (client as any).ensureDaemonAvailable = async () => {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {
        // Launch the successor after the incumbent's short test-only quiescent lifetime.
      }
      successor ??= await serveHunkSessionBrokerDaemon({ idleTimeoutMs: 0 });
    };

    try {
      await client.start();
      const retainedConnection = (client as any).connection;
      await waitUntil("first incompatible websocket", () => helloAttempts === 1);
      await Bun.sleep(35);
      expect(helloAttempts).toBe(1);

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
      expect((client as any).connection).toBe(retainedConnection);

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
      expect((client as any).connection).toBe(retainedConnection);
    } finally {
      client.stop();
      incumbent.stop(true);
      const runningSuccessor = successor as Awaited<
        ReturnType<typeof serveHunkSessionBrokerDaemon>
      > | null;
      runningSuccessor?.stop(true);
      if (runningSuccessor) await runningSuccessor.stopped;
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("retries the complete startup cycle and recovers without restarting the client", async () => {
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map((value) => String(value)).join(" "));
    };
    const client = new SessionBrokerClient(createRegistration(), createSnapshot(), {
      reconnectDelayMs: 10,
    });
    let attempts = 0;
    (client as any).ensureDaemonAndConnect = async () => {
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
    (client as any).ensureDaemonAndConnect = async () => {
      attempts += 1;
    };

    client.stop();
    await client.start();
    expect(attempts).toBe(0);
  });

  test("does not schedule recovery after stop wins a startup race", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reconnectScheduled = false;
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    (client as any).ensureDaemonAndConnect = async () => {
      await gate;
      throw new Error("late startup failure");
    };
    (client as any).scheduleReconnect = () => {
      reconnectScheduled = true;
    };

    const startup = client.start();
    client.stop();
    release();
    await startup;
    expect(reconnectScheduled).toBe(false);
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

    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map((value) => String(value)).join(" "));
    };

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
