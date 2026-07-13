import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestSessionRegistration,
  createTestSessionReviewFile,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import {
  buildSessionBrokerRuntimeMetadata,
  resolveSessionBrokerRuntimePaths,
  writeSessionBrokerRuntimeMetadata,
} from "./brokerLauncher";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "../session/protocol";
import { SessionBrokerClient } from "./brokerClient";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalDisable = process.env.HUNK_MCP_DISABLE;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const originalConsoleError = console.error;
const runtimeDirs: string[] = [];
const testNonce = "test-session-broker-client-nonce";

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

async function waitUntil(label: string, fn: () => boolean, timeoutMs = 5_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fn()) {
      return;
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

function createRuntimeDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-session-broker-client-test-"));
  runtimeDirs.push(dir);
  process.env.XDG_RUNTIME_DIR = dir;
  return dir;
}

function writeMetadata(
  config: { host: string; port: number; httpOrigin: string; wsOrigin: string },
  nonce = testNonce,
  pid = process.pid,
) {
  writeSessionBrokerRuntimeMetadata(
    resolveSessionBrokerRuntimePaths(config),
    buildSessionBrokerRuntimeMetadata({ config, nonce, pid }),
  );
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

  while (runtimeDirs.length > 0) {
    const dir = runtimeDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.error = originalConsoleError;
});

describe("Hunk session daemon client", () => {
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

  test("restartIncompatibleDaemon lets startup recover when the stale daemon already exited", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("gone");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config = {
      host: "127.0.0.1",
      port,
      httpOrigin: `http://127.0.0.1:${port}`,
      wsOrigin: `ws://127.0.0.1:${port}`,
    };

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());

    try {
      await expect((client as any).restartIncompatibleDaemon(config)).resolves.toBeUndefined();
    } finally {
      client.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("restartIncompatibleDaemon refuses to signal an unauthenticated health listener", async () => {
    createRuntimeDir();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: 54321, sessions: 0, pendingCommands: 0 }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config = {
      host: "127.0.0.1",
      port,
      httpOrigin: `http://127.0.0.1:${port}`,
      wsOrigin: `ws://127.0.0.1:${port}`,
    };

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const originalKill = process.kill;
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      await expect((client as any).restartIncompatibleDaemon(config)).rejects.toThrow(
        /occupied by a non-Hunk process/,
      );
      expect(killCalls.filter((call) => call.signal !== 0)).toEqual([]);
    } finally {
      process.kill = originalKill;
      client.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("restartIncompatibleDaemon refuses to signal when runtime metadata and health disagree on pid", async () => {
    createRuntimeDir();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          pid: 54321,
          nonce: testNonce,
          sessions: 0,
          pendingCommands: 0,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config = {
      host: "127.0.0.1",
      port,
      httpOrigin: `http://127.0.0.1:${port}`,
      wsOrigin: `ws://127.0.0.1:${port}`,
    };
    writeMetadata(config, testNonce, 12345);

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const originalKill = process.kill;
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      await expect((client as any).restartIncompatibleDaemon(config)).rejects.toThrow(
        /occupied by a non-Hunk process/,
      );
      expect(killCalls.filter((call) => call.signal !== 0)).toEqual([]);
    } finally {
      process.kill = originalKill;
      client.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("restartIncompatibleDaemon still signals a matching authenticated daemon", async () => {
    createRuntimeDir();
    const daemonPid = 54321;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          pid: daemonPid,
          nonce: testNonce,
          sessions: 0,
          pendingCommands: 0,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const config = {
      host: "127.0.0.1",
      port,
      httpOrigin: `http://127.0.0.1:${port}`,
      wsOrigin: `ws://127.0.0.1:${port}`,
    };
    writeMetadata(config, testNonce, daemonPid);

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    const originalKill = process.kill;
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      if (signal === "SIGTERM") {
        void new Promise<void>((resolve) => server.close(() => resolve()));
      }

      return true;
    }) as typeof process.kill;

    try {
      await expect((client as any).restartIncompatibleDaemon(config)).resolves.toBeUndefined();
      expect(killCalls.filter((call) => call.signal !== 0)).toEqual([
        { pid: daemonPid, signal: "SIGTERM" },
      ]);
    } finally {
      process.kill = originalKill;
      client.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("logs one actionable warning when a refreshed daemon rejects an older Hunk window", async () => {
    const listener = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: process.pid, sessions: 0, pendingCommands: 0 }));
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
            nonce: testNonce,
            sessions: 0,
            pendingCommands: 0,
          });
        }

        if (url.pathname === "/session-api/capabilities") {
          return Response.json({
            version: HUNK_SESSION_API_VERSION,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            nonce: testNonce,
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
          socket.close(1008, "Incompatible session registration.");
        },
        message() {},
      },
    });

    const messages: string[] = [];
    const client = new SessionBrokerClient(createRegistration(), createSnapshot());
    let reconnectScheduled = false;
    (client as any).scheduleReconnect = () => {
      reconnectScheduled = true;
    };
    (client as any).warnUnavailable = (error: unknown) => {
      messages.push(error instanceof Error ? error.message : String(error));
    };

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

      await (client as any).connect({
        host: "127.0.0.1",
        port,
        httpOrigin: `http://127.0.0.1:${port}`,
        wsOrigin: `ws://127.0.0.1:${port}`,
      });
      await waitUntil("incompatible session warning", () =>
        messages.some((message) =>
          message.includes("too old for the refreshed session broker daemon"),
        ),
      );

      expect(messages[0]).toContain(
        "This window is too old for the refreshed session broker daemon.",
      );
      expect(messages[0]).toContain("Restart the window to reconnect.");
      expect(reconnectScheduled).toBe(false);
      expect(websocketOpens).toBe(1);
    } finally {
      client.stop();
      server.stop(true);
    }
  }, 10_000);

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

    const client = new SessionBrokerClient(createRegistration(), createSnapshot());

    try {
      client.start();
      await waitUntil("initial session-daemon conflict warning", () => messages.length === 1);

      client.start();
      await Bun.sleep(2_000);

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
