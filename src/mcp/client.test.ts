import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  createTestSessionRegistration,
  createTestSessionReviewFile,
  createTestSessionSnapshot,
} from "../../test/helpers/mcp-fixtures";
import { HunkHostClient } from "./client";

const originalHost = process.env.HUNK_MCP_HOST;
const originalPort = process.env.HUNK_MCP_PORT;
const originalDisable = process.env.HUNK_MCP_DISABLE;
const originalUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
const originalConsoleError = console.error;

function createRegistration() {
  return createTestSessionRegistration({
    cwd: process.cwd(),
    inputKind: "diff",
    pid: process.pid,
    repoRoot: process.cwd(),
    sourceLabel: "before.ts -> after.ts",
    title: "before.ts ↔ after.ts",
    reviewFiles: [createTestSessionReviewFile({ path: "after.ts" })],
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

  console.error = originalConsoleError;
});

describe("Hunk MCP client", () => {
  test("logs one actionable warning when MCP is configured for a non-loopback host without opt-in", async () => {
    process.env.HUNK_MCP_HOST = "0.0.0.0";
    process.env.HUNK_MCP_PORT = "47657";
    delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
    delete process.env.HUNK_MCP_DISABLE;

    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map((value) => String(value)).join(" "));
    };

    const client = new HunkHostClient(createRegistration(), createSnapshot());

    try {
      client.start();
      await waitUntil("non-loopback MCP warning", () => messages.length === 1);

      expect(messages[0]).toContain(
        "[hunk:mcp] Hunk MCP refuses to bind 0.0.0.0:47657 because the daemon is local-only by default.",
      );
      expect(messages[0]).toContain("HUNK_MCP_UNSAFE_ALLOW_REMOTE=1");
    } finally {
      client.stop();
    }
  }, 10_000);

  test("logs one actionable warning when a non-Hunk listener owns the MCP port", async () => {
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

    const client = new HunkHostClient(createRegistration(), createSnapshot());

    try {
      client.start();
      await waitUntil("initial MCP conflict warning", () => messages.length === 1);

      client.start();
      await Bun.sleep(2_000);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        `[hunk:mcp] Hunk MCP port 127.0.0.1:${port} is already in use by another process.`,
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
