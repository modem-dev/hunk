import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type SessionRegistration,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "./serve";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

function parseInfo(value: unknown): TestSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  return title === null ? null : { title };
}

function parseState(value: unknown): TestSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  return selectedIndex === null ? null : { selectedIndex };
}

function createRegistration(overrides: Partial<SessionRegistration<TestSessionInfo>> = {}) {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    info: { title: "repo working tree" },
    ...overrides,
  } satisfies SessionRegistration<TestSessionInfo>;
}

function createSnapshot(
  overrides: Partial<SessionSnapshot<TestSessionState>["state"]> & { updatedAt?: string } = {},
) {
  const { updatedAt = "2026-04-15T00:00:00.000Z", ...stateOverrides } = overrides;
  return {
    updatedAt,
    state: {
      selectedIndex: 0,
      ...stateOverrides,
    },
  } satisfies SessionSnapshot<TestSessionState>;
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

describe("session broker node adapter", () => {
  test("serves the generic daemon API and websocket path through Node", async () => {
    const broker = new SessionBroker({
      parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
      parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
    });
    const daemon = createSessionBrokerDaemon({ broker, capabilities: { version: 1 } });
    const port = await reserveLoopbackPort();
    const server = await serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
    });

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(health.json()).resolves.toMatchObject({ ok: true, sessions: 0 });

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

      socket.send(
        JSON.stringify({
          type: "register",
          registration: createRegistration(),
          snapshot: createSnapshot(),
        }),
      );

      await waitUntil("session registration", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/broker`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "list" }),
        });
        if (!response.ok) {
          return null;
        }

        const payload = (await response.json()) as { sessions: { sessionId: string }[] };
        return payload.sessions.length === 1 ? payload : null;
      });

      const response = await fetch(`http://127.0.0.1:${port}/broker`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "get", selector: { sessionId: "session-1" } }),
      });
      await expect(response.json()).resolves.toMatchObject({
        session: {
          registration: { sessionId: "session-1" },
          snapshot: { state: { selectedIndex: 0 } },
        },
      });

      socket.close();
    } finally {
      await server.stop();
      await server.stopped;
    }
  });
});
