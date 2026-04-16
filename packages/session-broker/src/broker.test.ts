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

interface TestSessionInfo {
  title: string;
  files: string[];
}

interface TestSessionState {
  selectedIndex: number;
  noteCount: number;
}

type TestRegistration = SessionRegistration<TestSessionInfo>;
type TestSnapshot = SessionSnapshot<TestSessionState>;

type TestServerMessage =
  | SessionServerMessage<"annotate", { filePath: string; summary: string }>
  | SessionServerMessage<"reload_view", { ref: string }>;

function parseInfo(value: unknown): TestSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files)) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  const files = record.files.filter((entry): entry is string => typeof entry === "string");
  if (title === null || files.length !== record.files.length) {
    return null;
  }

  return { title, files };
}

function parseState(value: unknown): TestSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  const noteCount = brokerWireParsers.parseNonNegativeInt(record.noteCount);
  if (selectedIndex === null || noteCount === null) {
    return null;
  }

  return { selectedIndex, noteCount };
}

function createBroker() {
  return new SessionBroker<TestSessionInfo, TestSessionState, TestServerMessage>({
    parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
    parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  });
}

function createRegistration(
  overrides: Partial<TestRegistration> & { info?: Partial<TestSessionInfo> } = {},
): TestRegistration {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
    info: {
      title: "repo working tree",
      files: ["src/example.ts"],
      ...overrides.info,
    },
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
      noteCount: 0,
      ...stateOverrides,
    },
  };
}

describe("session broker wrapper", () => {
  test("stores raw registrations and snapshots without a custom projection adapter", () => {
    const broker = createBroker();
    const connection = { send() {} };

    expect(broker.registerSession(connection, createRegistration(), createSnapshot())).toBe(true);

    expect(broker.listSessions()).toEqual([
      {
        sessionId: "session-1",
        cwd: "/repo",
        repoRoot: "/repo",
        title: "repo working tree",
        connectedAt: expect.any(String),
        lastSeenAt: expect.any(String),
        registration: createRegistration(),
        snapshot: createSnapshot(),
      },
    ]);
  });

  test("rejects incompatible registrations using the shared envelope parser", () => {
    const broker = createBroker();
    const connection = { send() {} };

    expect(
      broker.registerSession(
        connection,
        {
          ...createRegistration(),
          registrationVersion: 0,
        },
        createSnapshot(),
      ),
    ).toBe(false);
    expect(broker.listSessions()).toEqual([]);
  });

  test("dispatches one raw command and resolves the async result", async () => {
    const broker = createBroker();
    const sent: string[] = [];
    const connection = {
      send(data: string) {
        sent.push(data);
      },
    };

    broker.registerSession(connection, createRegistration(), createSnapshot());

    const pending = broker.dispatchCommand<{ ok: true }, "annotate">({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "src/example.ts", summary: "Review note" },
      timeoutMessage: "Timed out waiting for annotate.",
    });

    const outgoing = JSON.parse(sent[0]!) as { requestId: string; command: string };
    expect(outgoing.command).toBe("annotate");

    broker.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result: { ok: true },
    });

    await expect(pending).resolves.toEqual({ ok: true });
  });
});
