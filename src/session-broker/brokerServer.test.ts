import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import { SessionBrokerState } from "@hunk/session-broker-core";
import { readSessionBrokerRuntimeMetadata } from "./brokerLauncher";
import { serveSessionBrokerDaemon } from "./brokerServer";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const runtimeDirs: string[] = [];

interface HealthResponse {
  ok: boolean;
  pid: number;
  nonce: string;
  sessions: number;
  pendingCommands: number;
  paths?: Record<string, string>;
  sessionApi?: string;
  sessionCapabilities?: string;
  sessionSocket?: string;
}

async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 1_500,
  intervalMs = 20,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

async function readHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number) {
  return waitUntil("daemon health", () => readHealth(port));
}

async function waitForShutdown(port: number, timeoutMs = 1_500) {
  await waitUntil(
    "daemon shutdown",
    async () => ((await readHealth(port)) === null ? true : null),
    timeoutMs,
  );
}

async function waitForSessionCount(port: number, count: number) {
  await waitUntil("session registration", async () => {
    const health = await readHealth(port);
    return health?.sessions === count ? health : null;
  });
}

function createRuntimeDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-session-broker-server-test-"));
  runtimeDirs.push(dir);
  process.env.XDG_RUNTIME_DIR = dir;
  return dir;
}

async function openSessionSocket(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open.")),
      500,
    );

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Websocket failed to open."));
      },
      { once: true },
    );
  });

  return socket;
}

async function readRawWebSocketHandshake(port: number, headers: string[]) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        [
          "GET /session HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          ...headers,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for raw websocket handshake response."));
    }, 1_000);

    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) {
        return;
      }

      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function openRegisteredSession(
  port: number,
  sessionId = "session-1",
  snapshotOverrides: Parameters<typeof createTestSessionSnapshot>[0] = {},
) {
  const socket = await openSessionSocket(port);

  socket.send(
    JSON.stringify({
      type: "register",
      registration: createTestSessionRegistration({
        launchedAt: "2026-03-24T00:00:00.000Z",
        pid: process.pid,
        sessionId,
      }),
      snapshot: createTestSessionSnapshot({
        updatedAt: "2026-03-24T00:00:00.000Z",
        ...snapshotOverrides,
      }),
    }),
  );

  await waitForSessionCount(port, 1);
  return socket;
}

async function waitForSocketClose(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket close.")),
      1_000,
    );

    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
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
});

describe("Hunk session daemon server", () => {
  test("refuses non-loopback binding unless explicitly allowed", () => {
    process.env.HUNK_MCP_HOST = "0.0.0.0";
    process.env.HUNK_MCP_PORT = "47657";
    delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;

    expect(() => serveSessionBrokerDaemon()).toThrow("local-only by default");
  });

  test("reports a clear error when the daemon port is already in use", async () => {
    const listener = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    try {
      expect(() => serveSessionBrokerDaemon()).toThrow("port is already in use");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  test("exposes only Hunk session endpoints and rejects the old MCP tool endpoint", async () => {
    createRuntimeDir();
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const healthPayload = (await health.json()) as HealthResponse;
      expect(healthPayload.paths).toEqual({
        health: "/health",
        socket: "/session",
      });
      expect(healthPayload).toMatchObject({
        sessionApi: `http://127.0.0.1:${port}/session-api`,
        sessionCapabilities: `http://127.0.0.1:${port}/session-api/capabilities`,
        sessionSocket: `ws://127.0.0.1:${port}/session`,
      });
      expect(healthPayload.nonce).toBeString();

      const genericCapabilities = await fetch(`http://127.0.0.1:${port}/broker/capabilities`);
      expect(genericCapabilities.status).toBe(404);

      const genericBroker = await fetch(`http://127.0.0.1:${port}/broker`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "list" }),
      });
      expect(genericBroker.status).toBe(404);

      const capabilities = await fetch(`http://127.0.0.1:${port}/session-api/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        version: 1,
        daemonVersion: 5,
        nonce: healthPayload.nonce,
        actions: [
          "list",
          "get",
          "context",
          "review",
          "navigate",
          "reload",
          "comment-add",
          "comment-apply",
          "comment-list",
          "comment-rm",
          "comment-clear",
        ],
      });

      const legacyMcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(legacyMcp.status).toBe(410);
      await expect(legacyMcp.json()).resolves.toMatchObject({
        error: "This app no longer exposes agent-facing MCP tools. Use the session CLI instead.",
      });

      expect(readSessionBrokerRuntimeMetadata()).toMatchObject({
        pid: process.pid,
        port,
        nonce: healthPayload.nonce,
      });
    } finally {
      server.stop(true);
    }
  });

  test("writes runtime metadata while serving and removes it on shutdown", async () => {
    createRuntimeDir();
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const health = await waitForHealth(port);
      expect(readSessionBrokerRuntimeMetadata()).toMatchObject({
        pid: process.pid,
        port,
        nonce: health.nonce,
      });
    } finally {
      server.stop(true);
    }

    await waitForShutdown(port);
    expect(readSessionBrokerRuntimeMetadata()).toBeNull();
  });

  test("rejects HTTP requests with non-loopback or wrong-port Host headers", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const attackerHostResponse = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { host: `attacker.example:${port}` },
      });

      expect(attackerHostResponse.status).toBe(403);
      await expect(attackerHostResponse.json()).resolves.toEqual({
        error: "Host header is not allowed for the local session broker.",
      });

      const missingPortResponse = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { host: "127.0.0.1" },
      });

      expect(missingPortResponse.status).toBe(403);
      await expect(missingPortResponse.json()).resolves.toEqual({
        error: "Host header is not allowed for the local session broker.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("rejects non-local Origin headers for HTTP and websocket requests", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api/capabilities`, {
        headers: { origin: "https://attacker.example" },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Origin is not allowed for the local session broker.",
      });

      const handshake = await readRawWebSocketHandshake(port, ["Origin: https://attacker.example"]);
      expect(handshake).toStartWith("HTTP/1.1 403");
    } finally {
      server.stop(true);
    }
  });

  test("requires JSON content type for session API posts", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "list" }),
      });

      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        error: "Expected Content-Type application/json.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("rejects session API bodies that exceed the size limit", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list", filler: "x".repeat(5 * 1024 * 1024) }),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("session broker limit"),
      });
    } finally {
      server.stop(true);
    }
  });

  test("closes snapshots for missing sessions with a specific not-registered reason", async () => {
    // Bun's Windows WebSocket client does not reliably surface this immediate server close.
    // The daemon-core test covers the close code/reason without the flaky transport layer.
    if (platform() === "win32") {
      return;
    }

    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon({
      idleTimeoutMs: 250,
      staleSessionTtlMs: 500,
      staleSessionSweepIntervalMs: 25,
    });
    const socket = await openSessionSocket(port);

    try {
      const closed = waitForSocketClose(socket);
      socket.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: "missing-session",
          snapshot: createTestSessionSnapshot({ updatedAt: "2026-03-24T00:00:00.000Z" }),
        }),
      );

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "Session not registered with broker.",
      });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  test("ignores incompatible registration payloads instead of poisoning session list", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon({
      idleTimeoutMs: 250,
      staleSessionTtlMs: 500,
      staleSessionSweepIntervalMs: 25,
    });
    const badSocket = await openSessionSocket(port);

    try {
      badSocket.send(
        JSON.stringify({
          type: "register",
          registration: {
            ...createTestSessionRegistration({
              launchedAt: "2026-03-24T00:00:00.000Z",
              pid: process.pid,
              sessionId: "stale-session",
            }),
            registrationVersion: 0,
            files: undefined,
          },
          snapshot: createTestSessionSnapshot({ updatedAt: "2026-03-24T00:00:00.000Z" }),
        }),
      );

      await waitUntil(
        "incompatible socket close",
        () => (badSocket.readyState === WebSocket.CLOSED ? true : null),
        1_000,
      );

      const emptyList = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "list" }),
      });
      expect(emptyList.status).toBe(200);
      await expect(emptyList.json()).resolves.toMatchObject({ sessions: [] });

      const goodSocket = await openRegisteredSession(port, "session-good");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "list" }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          sessions: [{ sessionId: "session-good" }],
        });
      } finally {
        goodSocket.close();
      }
    } finally {
      badSocket.close();
      server.stop(true);
    }
  });

  test("stays alive while at least one live session remains registered", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon({
      idleTimeoutMs: 60,
      staleSessionTtlMs: 500,
      staleSessionSweepIntervalMs: 25,
    });
    const socket = await openRegisteredSession(port);

    try {
      await Bun.sleep(150);
      await expect(waitForHealth(port)).resolves.toMatchObject({
        ok: true,
        sessions: 1,
      });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  test("shuts down after the last live session disconnects", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon({
      idleTimeoutMs: 75,
      staleSessionTtlMs: 500,
      staleSessionSweepIntervalMs: 25,
    });
    const socket = await openRegisteredSession(port);

    try {
      socket.close();
      await waitForSessionCount(port, 0);
      await waitForShutdown(port, 800);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  test("shuts down after stale-session pruning leaves zero live sessions", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon({
      idleTimeoutMs: 75,
      staleSessionTtlMs: 80,
      staleSessionSweepIntervalMs: 20,
    });
    const socket = await openRegisteredSession(port);

    try {
      await waitForShutdown(port, 1_000);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  test("forwards review options through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = SessionBrokerState.prototype.getSessionReview;
    SessionBrokerState.prototype.getSessionReview = function (selector, options) {
      expect(selector).toEqual({ sessionId: "session-1" });
      expect(options).toEqual({ includePatch: true, includeNotes: true });

      return {
        sessionId: "session-1",
        title: "repo diff",
        sourceLabel: "/repo",
        repoRoot: "/repo",
        inputKind: "vcs",
        selectedFile: {
          id: "file-1",
          path: "src/example.ts",
          additions: 1,
          deletions: 1,
          hunkCount: 1,
          patch: "@@ -1,1 +1,1 @@",
          hunks: [
            {
              index: 0,
              header: "@@ -1,1 +1,1 @@",
              oldRange: [1, 1],
              newRange: [1, 1],
            },
          ],
        },
        selectedHunk: {
          index: 0,
          header: "@@ -1,1 +1,1 @@",
          oldRange: [1, 1],
          newRange: [1, 1],
        },
        showAgentNotes: false,
        liveCommentCount: 0,
        files: [
          {
            id: "file-1",
            path: "src/example.ts",
            additions: 1,
            deletions: 1,
            hunkCount: 1,
            patch: "@@ -1,1 +1,1 @@",
            hunks: [
              {
                index: 0,
                header: "@@ -1,1 +1,1 @@",
                oldRange: [1, 1],
                newRange: [1, 1],
              },
            ],
          },
        ],
      };
    };

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "review",
          selector: { sessionId: "session-1" },
          includePatch: true,
          includeNotes: true,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        review: {
          files: [
            {
              path: "src/example.ts",
              patch: "@@ -1,1 +1,1 @@",
            },
          ],
        },
      });
    } finally {
      SessionBrokerState.prototype.getSessionReview = original;
      server.stop(true);
    }
  });

  test("forwards reload sourcePath through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = SessionBrokerState.prototype.dispatchCommand;
    SessionBrokerState.prototype.dispatchCommand = (({ command, input }: any) => {
      expect(command).toBe("reload_session");
      expect(input).toMatchObject({
        sessionPath: "/tmp/live-session",
        sourcePath: "/tmp/source-repo",
        nextInput: {
          kind: "vcs",
          staged: false,
          options: {},
        },
      });

      return Promise.resolve({
        sessionId: "session-1",
        inputKind: "vcs",
        title: "source-repo working tree",
        sourceLabel: "/tmp/source-repo",
        fileCount: 0,
        selectedHunkIndex: 0,
      });
    }) as SessionBrokerState["dispatchCommand"];

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "reload",
          selector: { sessionPath: "/tmp/live-session" },
          sourcePath: "/tmp/source-repo",
          nextInput: {
            kind: "vcs",
            staged: false,
            options: {},
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          sessionId: "session-1",
          inputKind: "vcs",
          sourceLabel: "/tmp/source-repo",
        },
      });
    } finally {
      SessionBrokerState.prototype.dispatchCommand = original;
      server.stop(true);
    }
  });

  test("serves review notes through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveSessionBrokerDaemon();
    const socket = await openRegisteredSession(port, "session-1", {
      reviewNoteCount: 2,
      reviewNotes: [
        {
          noteId: "user:1",
          source: "user",
          filePath: "src/example.ts",
          hunkIndex: 0,
          body: "Human note",
          createdAt: "2026-05-10T00:00:00.000Z",
          editable: true,
        },
        {
          noteId: "agent:1",
          source: "agent",
          filePath: "src/other.ts",
          body: "Agent note",
          createdAt: "2026-05-10T00:00:00.000Z",
          editable: false,
        },
      ],
    });

    try {
      const listResponse = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "comment-list",
          selector: { sessionId: "session-1" },
          type: "user",
        }),
      });

      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        comments: [{ noteId: "user:1", body: "Human note" }],
      });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  test("forwards comment batches through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = SessionBrokerState.prototype.dispatchCommand;
    SessionBrokerState.prototype.dispatchCommand = (({ command, input }: any) => {
      expect(command).toBe("comment_batch");
      expect(input).toMatchObject({
        sessionId: "session-1",
        revealMode: "none",
        comments: [
          {
            filePath: "src/example.ts",
            hunkIndex: 0,
            summary: "First",
            author: "Pi",
          },
          {
            filePath: "src/example.ts",
            hunkIndex: 1,
            summary: "Second",
            rationale: "Applied together.",
            author: "Pi",
          },
        ],
      });

      return Promise.resolve({
        applied: [
          {
            commentId: "comment-1",
            fileId: "file-1",
            filePath: "src/example.ts",
            hunkIndex: 0,
            side: "new",
            line: 2,
          },
          {
            commentId: "comment-2",
            fileId: "file-1",
            filePath: "src/example.ts",
            hunkIndex: 1,
            side: "new",
            line: 13,
          },
        ],
      });
    }) as SessionBrokerState["dispatchCommand"];

    const server = serveSessionBrokerDaemon();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/session-api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "comment-apply",
          selector: { sessionId: "session-1" },
          revealMode: "none",
          comments: [
            {
              filePath: "src/example.ts",
              hunkNumber: 1,
              summary: "First",
              author: "Pi",
            },
            {
              filePath: "src/example.ts",
              hunkNumber: 2,
              summary: "Second",
              rationale: "Applied together.",
              author: "Pi",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          applied: [
            { commentId: "comment-1", hunkIndex: 0, side: "new", line: 2 },
            { commentId: "comment-2", hunkIndex: 1, side: "new", line: 13 },
          ],
        },
      });
    } finally {
      SessionBrokerState.prototype.dispatchCommand = original;
      server.stop(true);
    }
  });
});
