import type { SessionBrokerDaemon, SessionBrokerSocketLike } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";
import { runConnectionFixture, type ConnectionFixtureMode } from "./connectionFixture";

/** Reserve one loopback port with Bun's native server API. */
async function reservePort() {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a fixture port.");
  return port;
}

const mode = process.argv[2] as ConnectionFixtureMode;
await runConnectionFixture(mode, {
  reservePort,
  createSocket: (target) => new WebSocket(target) as unknown as SessionBrokerSocketLike,
  startDaemon: async (daemon: SessionBrokerDaemon, port: number) => {
    const running = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    return {
      stop: () => running.stop(true),
      stopped: running.stopped,
    };
  },
});
