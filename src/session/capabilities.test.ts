import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionBrokerRuntimeMetadata,
  resolveSessionBrokerRuntimePaths,
  writeSessionBrokerRuntimeMetadata,
} from "../session-broker/brokerLauncher";
import { readHunkSessionDaemonCapabilities } from "./capabilities";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "./protocol";

const servers = new Set<ReturnType<typeof createServer>>();
const originalFetch = globalThis.fetch;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const runtimeDirs: string[] = [];
const testNonce = "test-session-daemon-nonce";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void,
) {
  const server = createServer(handler);
  servers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    config: {
      host: "127.0.0.1",
      port,
      httpOrigin: `http://127.0.0.1:${port}`,
      wsOrigin: `ws://127.0.0.1:${port}`,
    },
  };
}

function createRuntimeDir() {
  const dir = mkdtempSync(join(tmpdir(), "hunk-session-capabilities-test-"));
  runtimeDirs.push(dir);
  process.env.XDG_RUNTIME_DIR = dir;
  return dir;
}

function writeMetadata(
  config: {
    host: string;
    port: number;
    httpOrigin: string;
    wsOrigin: string;
  },
  nonce = testNonce,
) {
  writeSessionBrokerRuntimeMetadata(
    resolveSessionBrokerRuntimePaths(config),
    buildSessionBrokerRuntimeMetadata({ config, nonce }),
  );
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
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
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe("readHunkSessionDaemonCapabilities", () => {
  test("times out hung capability requests", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    createRuntimeDir();
    writeMetadata({
      host: "127.0.0.1",
      port: 47657,
      httpOrigin: "http://127.0.0.1:47657",
      wsOrigin: "ws://127.0.0.1:47657",
    });

    await expect(
      readHunkSessionDaemonCapabilities(
        {
          host: "127.0.0.1",
          port: 47657,
          httpOrigin: "http://127.0.0.1:47657",
          wsOrigin: "ws://127.0.0.1:47657",
        },
        10,
      ),
    ).rejects.toThrow("Timed out waiting for the Hunk session daemon to report capabilities.");
  });

  test("returns null for non-ok capability responses so callers can trigger daemon refresh", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    createRuntimeDir();
    writeMetadata(config);

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });

  test("returns null when the daemon omits the compatibility version field", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: HUNK_SESSION_API_VERSION, actions: ["list"] }));
    });
    createRuntimeDir();
    writeMetadata(config);

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });

  test("returns null when the daemon nonce does not match runtime metadata", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: HUNK_SESSION_API_VERSION,
          daemonVersion: HUNK_SESSION_DAEMON_VERSION,
          nonce: "wrong-nonce",
          actions: ["list", "get"],
        }),
      );
    });
    createRuntimeDir();
    writeMetadata(config);

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });

  test("accepts capabilities only when the versions and daemon nonce match", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: HUNK_SESSION_API_VERSION,
          daemonVersion: HUNK_SESSION_DAEMON_VERSION,
          nonce: testNonce,
          actions: ["list", "get"],
        }),
      );
    });
    createRuntimeDir();
    writeMetadata(config);

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toEqual({
      version: HUNK_SESSION_API_VERSION,
      daemonVersion: HUNK_SESSION_DAEMON_VERSION,
      nonce: testNonce,
      actions: ["list", "get"],
    });
  });
});
