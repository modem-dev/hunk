import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import { HunkDaemonState } from "./daemonState";
import { serveHunkSessionDaemon } from "./server";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;

interface HealthResponse {
  ok: boolean;
  pid: number;
  sessions: number;
  pendingCommands: number;
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

async function openSessionSocket(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open.")),
      500,
    );
    timeout.unref?.();

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

async function openRegisteredSession(port: number, sessionId = "session-1") {
  const socket = await openSessionSocket(port);

  socket.send(
    JSON.stringify({
      type: "register",
      registration: createTestSessionRegistration({
        launchedAt: "2026-03-24T00:00:00.000Z",
        pid: process.pid,
        sessionId,
      }),
      snapshot: createTestSessionSnapshot({ updatedAt: "2026-03-24T00:00:00.000Z" }),
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
    timeout.unref?.();

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
});

describe("Hunk session daemon server", () => {
  test("refuses non-loopback binding unless explicitly allowed", () => {
    process.env.HUNK_MCP_HOST = "0.0.0.0";
    process.env.HUNK_MCP_PORT = "47657";
    delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;

    expect(() => serveHunkSessionDaemon()).toThrow("local-only by default");
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
      expect(() => serveHunkSessionDaemon()).toThrow("port is already in use");
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  test("exposes session capabilities and rejects the old MCP tool endpoint", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveHunkSessionDaemon();

    try {
      const capabilities = await fetch(`http://127.0.0.1:${port}/session-api/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        version: 1,
        daemonVersion: 1,
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
        error: expect.stringContaining("Use `hunk session ...` instead"),
      });
    } finally {
      server.stop(true);
    }
  });

  test("closes snapshots for missing sessions with a specific not-registered reason", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const server = serveHunkSessionDaemon({
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
        reason: "Hunk session not registered with daemon.",
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

    const server = serveHunkSessionDaemon({
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

    const server = serveHunkSessionDaemon({
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

    const server = serveHunkSessionDaemon({
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

    const server = serveHunkSessionDaemon({
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

  test("forwards review includePatch through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = HunkDaemonState.prototype.getSessionReview;
    HunkDaemonState.prototype.getSessionReview = function (selector, options) {
      expect(selector).toEqual({ sessionId: "session-1" });
      expect(options).toEqual({ includePatch: true });

      return {
        sessionId: "session-1",
        title: "repo diff",
        sourceLabel: "/repo",
        repoRoot: "/repo",
        inputKind: "git",
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

    const server = serveHunkSessionDaemon();

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
      HunkDaemonState.prototype.getSessionReview = original;
      server.stop(true);
    }
  });

  test("forwards reload sourcePath through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = HunkDaemonState.prototype.sendReloadSession;
    HunkDaemonState.prototype.sendReloadSession = function (input) {
      expect(input).toMatchObject({
        sessionPath: "/tmp/live-session",
        sourcePath: "/tmp/source-repo",
        nextInput: {
          kind: "git",
          staged: false,
          options: {},
        },
      });

      return Promise.resolve({
        sessionId: "session-1",
        inputKind: "git",
        title: "source-repo working tree",
        sourceLabel: "/tmp/source-repo",
        fileCount: 0,
        selectedHunkIndex: 0,
      });
    };

    const server = serveHunkSessionDaemon();

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
            kind: "git",
            staged: false,
            options: {},
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          sessionId: "session-1",
          inputKind: "git",
          sourceLabel: "/tmp/source-repo",
        },
      });
    } finally {
      HunkDaemonState.prototype.sendReloadSession = original;
      server.stop(true);
    }
  });

  test("forwards comment batches through the session API", async () => {
    const port = await reserveLoopbackPort();
    process.env.HUNK_MCP_HOST = "127.0.0.1";
    process.env.HUNK_MCP_PORT = String(port);

    const original = HunkDaemonState.prototype.sendCommentBatch;
    HunkDaemonState.prototype.sendCommentBatch = function (input) {
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
    };

    const server = serveHunkSessionDaemon();

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
      HunkDaemonState.prototype.sendCommentBatch = original;
      server.stop(true);
    }
  });
});
