import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { platform } from "node:os";
import type { SessionCommandInput } from "../core/types";
import { createTestListedSession } from "../../test/helpers/session-daemon-fixtures";
import {
  runSessionCommand,
  setSessionCommandTestHooks,
  type HunkDaemonCliClient,
} from "./commands";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "./protocol";

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
  probeTest("throws a port-conflict error when the port is reachable but unhealthy", async () => {
    // A non-broker server occupies the port: reachable (TCP connects) but not health-OK.
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    process.env.HUNK_MCP_PORT = String(server.port);
    try {
      await expect(
        runSessionCommand({
          kind: "session",
          action: "list",
          output: "json",
        } satisfies SessionCommandInput),
      ).rejects.toThrow(/already in use/);
    } finally {
      server.stop(true);
    }
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
      restartDaemonForMissingAction: async () => {},
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
