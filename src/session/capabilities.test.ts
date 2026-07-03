import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readHunkSessionDaemonCapabilities } from "./capabilities";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "./protocol";

const servers = new Set<ReturnType<typeof createServer>>();
const originalFetch = globalThis.fetch;

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

afterEach(async () => {
  globalThis.fetch = originalFetch;
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

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });

  test("returns null when the daemon omits the compatibility version field", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: HUNK_SESSION_API_VERSION, actions: ["list"] }));
    });

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });

  test("accepts capabilities only when both API and daemon compatibility versions match", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version: HUNK_SESSION_API_VERSION,
          daemonVersion: HUNK_SESSION_DAEMON_VERSION,
          actions: ["list", "get"],
        }),
      );
    });

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toEqual({
      version: HUNK_SESSION_API_VERSION,
      daemonVersion: HUNK_SESSION_DAEMON_VERSION,
      actions: ["list", "get"],
    });
  });
});
