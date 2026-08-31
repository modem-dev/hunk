import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { SessionBrokerDaemon, SessionBrokerSocketLike } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-node";
import {
  runConnectionFixture,
  type ConnectionFixtureMode,
} from "../session-broker-runtime/connectionFixture";

/** Reserve one loopback port with Node's native TCP server. */
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

const packageJson = process.env.HUNK_SESSION_BROKER_NODE_PACKAGE_JSON;
if (!packageJson) throw new TypeError("HUNK_SESSION_BROKER_NODE_PACKAGE_JSON is required.");
const require = createRequire(packageJson);
const NodeWebSocket = require("ws") as new (url: string) => SessionBrokerSocketLike;
const mode = process.argv[2] as ConnectionFixtureMode;

await runConnectionFixture(mode, {
  reservePort,
  createSocket: (target) => new NodeWebSocket(target),
  startDaemon: async (daemon: SessionBrokerDaemon, port: number) =>
    serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port }),
});
