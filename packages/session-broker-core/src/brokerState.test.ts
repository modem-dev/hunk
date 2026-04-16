import { describe, expect, test } from "bun:test";
import {
  SessionBrokerState,
  resolveSessionTarget,
  type SessionBrokerListedSession,
  type SessionBrokerViewAdapter,
} from "./brokerState";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "./brokerWire";
import type { SessionRegistration, SessionServerMessage, SessionSnapshot } from "./types";

interface TestSessionInfo {
  title: string;
  files: string[];
}

interface TestSessionState {
  selectedIndex: number;
  noteCount: number;
}

interface TestListedSession extends SessionBrokerListedSession {
  pid: number;
  launchedAt: string;
  fileCount: number;
  snapshot: SessionSnapshot<TestSessionState>;
}

interface TestSelectedContext {
  sessionId: string;
  selectedIndex: number;
}

interface TestSessionReview {
  sessionId: string;
  title: string;
  fileCount: number;
  includePatch: boolean;
}

interface TestCommentSummary {
  id: string;
  filePath?: string;
}

type TestSessionRegistration = SessionRegistration<TestSessionInfo>;
type TestSessionSnapshot = SessionSnapshot<TestSessionState>;

type TestServerMessage =
  | SessionServerMessage<"annotate", { filePath: string; summary: string; reveal?: boolean }>
  | SessionServerMessage<"reload_view", { ref: string }>
  | SessionServerMessage<"clear_annotations", { filePath?: string }>;

type TestCommandResult =
  | { kind: "annotated"; annotationId: string }
  | { kind: "reloaded"; ref: string }
  | { kind: "cleared"; removedCount: number };

function parseTestInfo(value: unknown): TestSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record || !Array.isArray(record.files)) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  const files = record.files.filter((entry): entry is string => typeof entry === "string");
  if (title === null || files.length !== record.files.length) {
    return null;
  }

  return {
    title,
    files,
  };
}

function parseTestState(value: unknown): TestSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  const noteCount = brokerWireParsers.parseNonNegativeInt(record.noteCount);
  if (selectedIndex === null || noteCount === null) {
    return null;
  }

  return {
    selectedIndex,
    noteCount,
  };
}

const testBrokerView: SessionBrokerViewAdapter<
  TestSessionInfo,
  TestSessionState,
  TestListedSession,
  TestSelectedContext,
  TestSessionReview,
  TestCommentSummary
> = {
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseTestInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseTestState),
  buildListedSession: (entry) => ({
    sessionId: entry.registration.sessionId,
    pid: entry.registration.pid,
    cwd: entry.registration.cwd,
    repoRoot: entry.registration.repoRoot,
    launchedAt: entry.registration.launchedAt,
    title: entry.registration.info.title,
    fileCount: entry.registration.info.files.length,
    snapshot: entry.snapshot,
  }),
  buildSelectedContext: (session) => ({
    sessionId: session.sessionId,
    selectedIndex: session.snapshot.state.selectedIndex,
  }),
  buildSessionReview: (entry, options) => ({
    sessionId: entry.registration.sessionId,
    title: entry.registration.info.title,
    fileCount: entry.registration.info.files.length,
    includePatch: options.includePatch ?? false,
  }),
  listComments: (_session, filter) => [{ id: "note-1", filePath: filter.filePath }],
};

function createState() {
  return new SessionBrokerState<
    TestSessionInfo,
    TestSessionState,
    TestServerMessage,
    TestCommandResult,
    TestListedSession,
    TestSelectedContext,
    TestSessionReview,
    TestCommentSummary
  >(testBrokerView);
}

function createRegistration(
  overrides: Partial<TestSessionRegistration> & { info?: Partial<TestSessionInfo> } = {},
): TestSessionRegistration {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
    info: {
      title: "repo working tree",
      files: ["src/example.ts"],
      ...overrides.info,
    },
  };
}

function createSnapshot(
  overrides: Partial<TestSessionSnapshot["state"]> & { updatedAt?: string } = {},
): TestSessionSnapshot {
  const { updatedAt = "2026-03-22T00:00:00.000Z", ...stateOverrides } = overrides;

  return {
    updatedAt,
    state: {
      selectedIndex: 0,
      noteCount: 0,
      ...stateOverrides,
    },
  };
}

function createListedSession(overrides: Partial<TestListedSession> = {}): TestListedSession {
  const snapshot = overrides.snapshot ?? createSnapshot();

  return {
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    title: "repo working tree",
    fileCount: 1,
    snapshot,
    ...overrides,
  };
}

describe("session broker state", () => {
  test("resolves one target session by session id, session path, repo root, or sole-session fallback", () => {
    const one = [createListedSession()];
    const two = [
      createListedSession(),
      createListedSession({
        sessionId: "session-2",
        cwd: "/other-session",
        repoRoot: "/repo",
        title: "repo secondary view",
        snapshot: createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
      }),
    ];

    expect(resolveSessionTarget(one, {}).sessionId).toBe("session-1");
    expect(resolveSessionTarget(one, { sessionPath: "/repo" }).sessionId).toBe("session-1");
    expect(resolveSessionTarget(one, { repoRoot: "/repo" }).sessionId).toBe("session-1");
    expect(resolveSessionTarget(two, { sessionId: "session-2" }).sessionId).toBe("session-2");
    expect(() => resolveSessionTarget(two, {})).toThrow(
      "specify sessionId, sessionPath, or repoRoot",
    );
    expect(() => resolveSessionTarget(two, { repoRoot: "/repo" })).toThrow(
      "specify sessionId instead",
    );
  });

  test("keeps session-path matching tied to the live session cwd", () => {
    const sessions = [
      createListedSession({
        sessionId: "session-f",
        cwd: "/live-session",
        repoRoot: "/source-f",
      }),
      createListedSession({
        sessionId: "session-a",
        cwd: "/other-session",
        repoRoot: "/source-a",
      }),
    ];

    expect(resolveSessionTarget(sessions, { sessionPath: "/live-session" }).sessionId).toBe(
      "session-f",
    );
    expect(resolveSessionTarget(sessions, { repoRoot: "/source-a" }).sessionId).toBe("session-a");
  });

  test("delegates session projections to the app adapter", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot({ noteCount: 2 }));

    expect(state.getSelectedContext({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      selectedIndex: 0,
    });
    expect(state.getSessionReview({ sessionId: "session-1" }, { includePatch: true })).toEqual({
      sessionId: "session-1",
      title: "repo working tree",
      fileCount: 1,
      includePatch: true,
    });
    expect(state.listComments({ sessionId: "session-1" }, { filePath: "src/example.ts" })).toEqual([
      { id: "note-1", filePath: "src/example.ts" },
    ]);
  });

  test("ignores incompatible session registrations so listings stay usable after upgrades", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    const accepted = state.registerSession(
      socket,
      {
        ...createRegistration(),
        registrationVersion: 0,
      },
      createSnapshot(),
    );

    expect(accepted).toBe(false);
    expect(state.listSessions()).toEqual([]);
  });

  test("reports invalid snapshot updates without replacing the last valid selection", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const result = state.updateSnapshot("session-1", {
      selectedIndex: "oops",
    });

    expect(result).toBe("invalid");
    expect(state.getSession({ sessionId: "session-1" }).snapshot.state.selectedIndex).toBe(0);
  });

  test("reports missing sessions separately from invalid snapshot payloads", () => {
    const state = createState();

    expect(
      state.updateSnapshot("missing-session", {
        selectedIndex: 0,
      }),
    ).toBe("not-found");
  });

  test("routes one opaque broker command to the live session and resolves the async result", async () => {
    const state = createState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: {
        sessionId: "session-1",
      },
      command: "annotate",
      input: {
        filePath: "src/example.ts",
        summary: "Review note",
        reveal: true,
      },
      timeoutMessage: "Timed out waiting for the session to apply the note.",
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
      input: { filePath: string; summary: string; reveal?: boolean };
    };

    expect(outgoing.command).toBe("annotate");
    expect(outgoing.input).toEqual({
      filePath: "src/example.ts",
      summary: "Review note",
      reveal: true,
    });

    const result = {
      kind: "annotated" as const,
      annotationId: "annotation-1",
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("rejects in-flight commands when the session disconnects", async () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: {
        sessionId: "session-1",
      },
      command: "annotate",
      input: {
        filePath: "src/example.ts",
        summary: "Review note",
      },
      timeoutMessage: "Timed out waiting for the session to apply the note.",
    });

    state.unregisterSocket(socket);

    await expect(pending).rejects.toThrow("disconnected");
  });

  test("rejects in-flight commands when a session reconnects on a new socket", async () => {
    const state = createState();
    const originalSocket = {
      send() {},
    };
    const replacementSocket = {
      send() {},
    };

    state.registerSession(originalSocket, createRegistration(), createSnapshot());
    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: {
        sessionId: "session-1",
      },
      command: "annotate",
      input: {
        filePath: "src/example.ts",
        summary: "Review note",
      },
      timeoutMessage: "Timed out waiting for the session to apply the note.",
    });

    state.registerSession(
      replacementSocket,
      createRegistration(),
      createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
    );

    await expect(pending).rejects.toThrow("reconnected before the command completed");
    expect(state.listSessions()).toHaveLength(1);
  });

  test("rejects commands immediately when the live session socket cannot accept them", async () => {
    const state = createState();
    const socket = {
      send() {
        throw new Error("socket closed");
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    await expect(
      state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
        selector: {
          sessionId: "session-1",
        },
        command: "annotate",
        input: {
          filePath: "src/example.ts",
          summary: "Review note",
        },
        timeoutMessage: "Timed out waiting for the session to apply the note.",
      }),
    ).rejects.toThrow("socket closed");
    expect(state.getPendingCommandCount()).toBe(0);
  });

  test("prunes stale sessions and rejects their in-flight commands", async () => {
    const state = createState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: {
        sessionId: "session-1",
      },
      command: "annotate",
      input: {
        filePath: "src/example.ts",
        summary: "Review note",
      },
      timeoutMessage: "Timed out waiting for the session to apply the note.",
    });

    expect(sent).toHaveLength(1);
    const removed = state.pruneStaleSessions({
      ttlMs: 1,
      now: Date.now() + 10,
    });

    expect(removed).toBe(1);
    expect(state.listSessions()).toHaveLength(0);
    await expect(pending).rejects.toThrow("stale");
  });

  test("heartbeats keep an otherwise idle session from being pruned", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const registeredAt = Date.now();

    expect(
      state.pruneStaleSessions({
        ttlMs: 50,
        now: registeredAt + 25,
      }),
    ).toBe(0);

    state.markSessionSeen("session-1");

    expect(
      state.pruneStaleSessions({
        ttlMs: 50,
        now: Date.now() + 25,
      }),
    ).toBe(0);
    expect(state.listSessions()).toHaveLength(1);
  });
});
