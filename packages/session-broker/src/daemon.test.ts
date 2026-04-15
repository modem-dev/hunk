import { describe, expect, test } from "bun:test";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import { SessionBroker } from "./broker";
import { createSessionBrokerDaemon } from "./daemon";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

type TestRegistration = SessionRegistration<TestSessionInfo>;
type TestSnapshot = SessionSnapshot<TestSessionState>;
type TestServerMessage = SessionServerMessage<"annotate", { summary: string }>;

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

function createBroker() {
  return new SessionBroker<TestSessionInfo, TestSessionState, TestServerMessage>({
    parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
    parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  });
}

function createRegistration(overrides: Partial<TestRegistration> = {}): TestRegistration {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    info: { title: "repo working tree" },
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<TestSnapshot["state"]> & { updatedAt?: string } = {},
): TestSnapshot {
  const { updatedAt = "2026-04-15T00:00:00.000Z", ...stateOverrides } = overrides;

  return {
    updatedAt,
    state: {
      selectedIndex: 0,
      ...stateOverrides,
    },
  };
}

function createConnection() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;

  return {
    sent,
    get closed() {
      return closed;
    },
    connection: {
      send(data: string) {
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closed = { code, reason };
      },
    },
  };
}

describe("session broker daemon", () => {
  test("serves health and raw list/get requests", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1, name: "test-broker" },
    });
    const { connection } = createConnection();
    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "register",
        registration: createRegistration(),
        snapshot: createSnapshot(),
      }),
    );

    await expect(
      daemon.handleRequest(new Request("http://broker.test/health")),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      daemon.handleRequest(new Request("http://broker.test/broker/capabilities")),
    ).resolves.toBeInstanceOf(Response);

    const listResponse = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        body: JSON.stringify({ action: "list" }),
      }),
    );
    expect(listResponse).toBeInstanceOf(Response);
    await expect(listResponse?.json()).resolves.toMatchObject({
      sessions: [{ sessionId: "session-1", title: "repo working tree" }],
    });

    const getResponse = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        body: JSON.stringify({ action: "get", selector: { sessionId: "session-1" } }),
      }),
    );
    await expect(getResponse?.json()).resolves.toMatchObject({
      session: {
        registration: { sessionId: "session-1" },
        snapshot: { state: { selectedIndex: 0 } },
      },
    });

    daemon.shutdown();
  });

  test("dispatches one raw command through the broker API", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
    });
    const session = createConnection();
    const { connection, sent } = session;
    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "register",
        registration: createRegistration(),
        snapshot: createSnapshot(),
      }),
    );

    const pendingResponse = daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        body: JSON.stringify({
          action: "dispatch",
          selector: { sessionId: "session-1" },
          command: "annotate",
          input: { summary: "Review note" },
        }),
      }),
    );

    await Bun.sleep(0);
    const outgoing = JSON.parse(sent[sent.length - 1]!) as { requestId: string; command: string };
    expect(outgoing.command).toBe("annotate");

    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "command-result",
        requestId: outgoing.requestId,
        ok: true,
        result: { applied: true },
      }),
    );

    const response = await pendingResponse;
    await expect(response?.json()).resolves.toEqual({ result: { applied: true } });
    daemon.shutdown();
  });

  test("closes incompatible snapshot updates with a specific reason", () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
    });
    const session = createConnection();
    const { connection } = session;

    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "snapshot",
        sessionId: "missing-session",
        snapshot: createSnapshot(),
      }),
    );

    expect(session.closed).toEqual({
      code: 1008,
      reason: "Session not registered with broker.",
    });
    daemon.shutdown();
  });

  test("requests shutdown after the idle timeout when no sessions remain", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      idleTimeoutMs: 20,
      staleSessionSweepIntervalMs: 10,
      capabilities: { version: 1 },
    });

    await expect(daemon.stopped).resolves.toBeUndefined();
  });
});
