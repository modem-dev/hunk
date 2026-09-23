/**
 * Stands in for one Hunk window: runs the real `SessionBrokerClient` against the daemon named
 * by `HUNK_MCP_PORT`, at whatever revision `HUNK_INTERNAL_SESSION_DAEMON_VERSION` selects, and
 * prints every daemon-link notice as one JSON line. Used by the daemon restart integration test
 * to attach windows from two builds without a terminal.
 */
import { join } from "node:path";
import { SessionBrokerClient } from "../../../packages/hunk/src/session/broker/brokerClient";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../helpers/session-daemon-fixtures";

// A window that finds no daemon spawns one from its own entrypoint. This process's entrypoint is
// the fixture, so point the launch command at Hunk's real entrypoint the way a window's argv does;
// otherwise a slow health probe would make the fixture spawn copies of itself as "daemons".
process.argv[1] = join(import.meta.dir, "../../../packages/hunk/src/main.tsx");

const sessionId = process.env.PRODUCER_FIXTURE_SESSION_ID ?? "producer-fixture";
const client = new SessionBrokerClient(
  createTestSessionRegistration({ sessionId, pid: process.pid, cwd: process.cwd() }),
  createTestSessionSnapshot(),
  { reconnectDelayMs: 300, stalePollDelayMs: 1_000 },
);
client.subscribeConnectionNotice((notice) => {
  console.log(JSON.stringify({ notice, state: client.getConnectionState() }));
});
client.start();
// Stay alive like a window would; the test kills the process when it is done.
setInterval(() => undefined, 60_000);
