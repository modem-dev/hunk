import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { platform } from "node:os";
import type { SessionCommandInput } from "../../core/run/commandInputs";
import { createTestListedSession } from "../../../../../test/helpers/session-daemon-fixtures";
import {
  runSessionCommand,
  setSessionCommandTestHooks,
  type HunkDaemonCliClient,
} from "./commands";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { SessionBrokerClientAuthenticationError } from "@hunk/session-broker";
import { DaemonBuildMismatchError } from "./errors";
import { resolveCliVersion } from "../../core/run/version";

// These tests exercise the REAL resolveDaemonAvailability path (which the hook-based suite in
// commands.test.ts deliberately bypasses) by pointing the broker config at a known-free loopback
// port via HUNK_MCP_PORT. No daemon is listening there, so the health and reachability probes
// resolve naturally — no module mocking, so nothing leaks into sibling suites.
const originalPort = process.env.HUNK_MCP_PORT;

// These cases drive the real availability probe against a loopback port with no daemon. Bun's
// Windows networking does not reliably surface a connection refusal for a closed loopback port
// (the health-probe fetch can hang without honoring its abort), so the probe-backed cases are
// Unix-only. The behavior they assert is platform-independent and fully covered on Linux/macOS.
const probeTest = platform() === "win32" ? test.skip : test;

/** Reserve a loopback port, then release it so nothing is listening on it. */
async function reserveFreePort() {
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

beforeEach(() => {
  setSessionCommandTestHooks(null);
});

afterEach(() => {
  setSessionCommandTestHooks(null);
  if (originalPort === undefined) {
    delete process.env.HUNK_MCP_PORT;
  } else {
    process.env.HUNK_MCP_PORT = originalPort;
  }
});

describe("resolveDaemonAvailability with no daemon listening", () => {
  probeTest("returns an empty session list instead of erroring", async () => {
    process.env.HUNK_MCP_PORT = String(await reserveFreePort());
    const output = await runSessionCommand({
      kind: "session",
      action: "list",
      output: "json",
    } satisfies SessionCommandInput);
    expect(JSON.parse(output)).toEqual({ sessions: [] });
  });

  probeTest(
    "throws a clear error for a non-list command when no sessions are registered",
    async () => {
      process.env.HUNK_MCP_PORT = String(await reserveFreePort());
      await expect(
        runSessionCommand({
          kind: "session",
          action: "get",
          selector: { sessionId: "session-1" },
          output: "json",
        } satisfies SessionCommandInput),
      ).rejects.toThrow(/No active Hunk sessions/);
    },
  );
});

describe("resolveDaemonAvailability with a foreign process on the port", () => {
  probeTest("throws a port-conflict error with the terminal health failure", async () => {
    // The second response proves the diagnostic comes from the probe after TCP reachability,
    // rather than stale evidence captured before a listener generation could change.
    let healthRequests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        healthRequests += 1;
        return new Response("nope", { status: healthRequests === 1 ? 503 : 404 });
      },
    });
    process.env.HUNK_MCP_PORT = String(server.port);
    try {
      await expect(
        runSessionCommand({
          kind: "session",
          action: "list",
          output: "json",
        } satisfies SessionCommandInput),
      ).rejects.toThrow(
        /already in use.*Hunk health probe returned HTTP 404 after \d+ms.*busy Hunk daemon or another process/,
      );
      expect(healthRequests).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  probeTest("returns an empty list when the listener disappears during health checks", async () => {
    let healthRequests = 0;
    let server!: ReturnType<typeof Bun.serve>;
    server = Bun.serve({
      port: 0,
      fetch: () => {
        healthRequests += 1;
        if (healthRequests === 2) queueMicrotask(() => server.stop(true));
        return new Response("unavailable", { status: 503 });
      },
    });
    process.env.HUNK_MCP_PORT = String(server.port);

    try {
      const output = await runSessionCommand({
        kind: "session",
        action: "list",
        output: "json",
      } satisfies SessionCommandInput);
      expect(JSON.parse(output)).toEqual({ sessions: [] });
      expect(healthRequests).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

describe("daemon build mismatch errors", () => {
  /** A client whose hello the daemon refuses, the way a revision mismatch presents. */
  function refusedClient(): HunkDaemonCliClient {
    return {
      getCapabilities: async () => {
        throw new SessionBrokerClientAuthenticationError();
      },
    } as unknown as HunkDaemonCliClient;
  }

  function adminStatus(daemonVersion: number, appVersion: string) {
    return {
      kind: "status" as const,
      status: {
        adminScopeVersion: 1 as const,
        daemonVersion,
        appVersion,
        pid: 4242,
        startedAt: "2026-01-01T00:00:00.000Z",
        uptimeMs: 1_000,
        sessions: [
          {
            sessionId: "abcdef12-0000",
            title: "repo working tree",
            cwd: "/repo",
            pid: 100,
            clientDaemonVersion: daemonVersion,
          },
          {
            sessionId: "12345678-0000",
            title: "repo show HEAD",
            cwd: "/repo",
            pid: 101,
            clientDaemonVersion: daemonVersion,
          },
        ],
      },
    };
  }

  const cliBuild = { daemonVersion: HUNK_SESSION_DAEMON_VERSION, appVersion: resolveCliVersion() };

  async function runListExpectingMismatch() {
    try {
      await runSessionCommand({ kind: "session", action: "list", output: "json" });
    } catch (error) {
      if (error instanceof DaemonBuildMismatchError) return error;
      throw error;
    }
    throw new Error("Expected a daemon build mismatch error.");
  }

  test("recommends a restart with the attached windows when the daemon is older", async () => {
    setSessionCommandTestHooks({
      createClient: refusedClient,
      resolveDaemonAvailability: async () => true,
      probeDaemonAdminStatus: async () => adminStatus(HUNK_SESSION_DAEMON_VERSION - 1, "0.21.1"),
    });

    const error = await runListExpectingMismatch();
    expect(error.details).toEqual({
      kind: "daemon-build-mismatch",
      daemon: { daemonVersion: HUNK_SESSION_DAEMON_VERSION - 1, appVersion: "0.21.1" },
      cli: cliBuild,
      attachedSessions: {
        count: 2,
        sessions: [
          { sessionId: "abcdef12-0000", title: "repo working tree", cwd: "/repo", pid: 100 },
          { sessionId: "12345678-0000", title: "repo show HEAD", cwd: "/repo", pid: 101 },
        ],
      },
      recommendedAction: "restart-daemon",
    });
    expect(error.message).toBe("The session daemon is an older Hunk build and refuses this CLI.");
    expect(error.suggestions).toEqual([
      "Run `hunk daemon restart` to replace it, then re-run `hunk session list`; windows that could not register attach automatically.",
      "Restarting disconnects 2 attached windows; they must be relaunched, losing their notes. Closing them instead lets the daemon exit on its own after about a minute.",
    ]);
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      message: error.message,
      kind: "daemon-build-mismatch",
      recommendedAction: "restart-daemon",
    });
  });

  test("recommends the newer Hunk build when the daemon is newer", async () => {
    setSessionCommandTestHooks({
      createClient: refusedClient,
      resolveDaemonAvailability: async () => true,
      probeDaemonAdminStatus: async () => adminStatus(HUNK_SESSION_DAEMON_VERSION + 1, "0.23.0"),
    });

    const error = await runListExpectingMismatch();
    expect(error.details).toMatchObject({
      daemon: { daemonVersion: HUNK_SESSION_DAEMON_VERSION + 1, appVersion: "0.23.0" },
      attachedSessions: { count: 2 },
      recommendedAction: "use-newer-hunk",
    });
    expect(error.message).toBe("The session daemon is a newer Hunk build and refuses this CLI.");
    expect(error.suggestions).toEqual([
      "Use the newer Hunk build the daemon was started from, or run `hunk daemon restart` from this build (2 attached windows would be disconnected and could not reconnect).",
    ]);
  });

  // Intent: the daemon being upgraded away from does not speak the admin scope, so the only
  // facts available are the launch metadata's; the recommendation is still a restart.
  test("falls back to launch metadata when the daemon predates the admin scope", async () => {
    setSessionCommandTestHooks({
      createClient: refusedClient,
      resolveDaemonAvailability: async () => true,
      probeDaemonAdminStatus: async () => ({ kind: "unsupported" }),
      readLaunchMetadata: () => ({
        pid: 777,
        command: "/usr/local/bin/hunk",
        args: ["daemon", "serve"],
        launchedAt: "2026-09-08T09:42:00.000Z",
      }),
    });

    const error = await runListExpectingMismatch();
    expect(error.details).toEqual({
      kind: "daemon-build-mismatch",
      daemon: null,
      cli: cliBuild,
      attachedSessions: null,
      launch: {
        pid: 777,
        command: "/usr/local/bin/hunk daemon serve",
        launchedAt: "2026-09-08T09:42:00.000Z",
      },
      recommendedAction: "restart-daemon",
    });
    expect(error.message).toBe(
      "The session daemon is an older Hunk build that predates `hunk daemon status` and refuses this CLI (pid 777, started 2026-09-08T09:42:00.000Z, command /usr/local/bin/hunk daemon serve).",
    );
    expect(error.suggestions[1]).toBe(
      "Restarting disconnects an unknown number of attached windows; they must be relaunched, losing their notes. Closing them instead lets the daemon exit on its own after about a minute.",
    );
  });

  test("reports a same-revision daemon that still lacks the action as a mismatch", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        ({
          getCapabilities: async () => ({
            version: HUNK_SESSION_API_VERSION,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            actions: ["get"],
          }),
        }) as unknown as HunkDaemonCliClient,
      resolveDaemonAvailability: async () => true,
      probeDaemonAdminStatus: async () =>
        adminStatus(HUNK_SESSION_DAEMON_VERSION, cliBuild.appVersion),
    });

    const error = await runListExpectingMismatch();
    expect(error.details).toMatchObject({
      daemon: { daemonVersion: HUNK_SESSION_DAEMON_VERSION },
      recommendedAction: "restart-daemon",
    });
    expect(error.message).toBe("The session daemon is an older Hunk build and refuses this CLI.");
  });
});

describe("text output formatting", () => {
  /** CLI client whose capabilities satisfy ensureRequiredAction. */
  function createFakeClient(overrides: Partial<HunkDaemonCliClient> = {}): HunkDaemonCliClient {
    return {
      getCapabilities: async () => ({
        version: HUNK_SESSION_API_VERSION,
        daemonVersion: HUNK_SESSION_DAEMON_VERSION,
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
      }),
      listSessions: async () => [createTestListedSession({ sessionId: "session-1" })],
      reloadSession: async () => ({
        sessionId: "session-1",
        inputKind: "show",
        title: "repo show HEAD~1",
        sourceLabel: "/repo",
        fileCount: 1,
        selectedFilePath: "README.md",
        selectedHunkIndex: 0,
      }),
      addComment: async () => ({
        commentId: "comment-1",
        fileId: "file-1",
        filePath: "README.md",
        hunkIndex: 0,
        side: "new",
        line: 1,
      }),
      clearComments: async () => ({ removedCount: 0, remainingCommentCount: 0 }),
      ...overrides,
    } as HunkDaemonCliClient;
  }

  test("renders reload, comment-add, and comment-clear as non-empty text", async () => {
    setSessionCommandTestHooks({
      resolveDaemonAvailability: async () => true,
      createClient: () => createFakeClient(),
    });

    const reload = await runSessionCommand({
      kind: "session",
      action: "reload",
      selector: { sessionId: "session-1" },
      nextInput: { kind: "show", ref: "HEAD~1", options: {} },
      output: "text",
    } satisfies SessionCommandInput);
    expect(reload).toBeString();
    expect(reload.length).toBeGreaterThan(0);

    const added = await runSessionCommand({
      kind: "session",
      action: "comment-add",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      side: "new",
      line: 1,
      summary: "note",
      reveal: false,
      output: "text",
    } satisfies SessionCommandInput);
    expect(added).toBeString();
    expect(added.length).toBeGreaterThan(0);

    const cleared = await runSessionCommand({
      kind: "session",
      action: "comment-clear",
      selector: { sessionId: "session-1" },
      confirmed: true,
      output: "text",
    } satisfies SessionCommandInput);
    expect(cleared).toBeString();
    expect(cleared.length).toBeGreaterThan(0);
  });
});
