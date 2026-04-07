import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readHunkSessionDaemonCapabilities } from "./capabilities";

const servers = new Set<ReturnType<typeof createServer>>();

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
  test("returns null for non-ok capability responses so callers can trigger daemon refresh", async () => {
    const { config } = await listen((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });

    await expect(readHunkSessionDaemonCapabilities(config)).resolves.toBeNull();
  });
});
