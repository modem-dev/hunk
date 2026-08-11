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

class PreparsedTestBrokerState extends SessionBrokerState<
  TestSessionInfo,
  TestSessionState,
  TestServerMessage,
  TestCommandResult,
  TestListedSession,
  TestSelectedContext,
  TestSessionReview,
  TestCommentSummary
> {
  /** Expose the specialized-broker registration seam to this core contract test. */
  registerParsed(
    socket: { send(data: string): unknown },
    registration: TestSessionRegistration,
    snapshot: TestSessionSnapshot,
  ) {
    return this.registerParsedSession(socket, registration, snapshot);
  }

  /** Expose the specialized-broker snapshot seam to this core contract test. */
  updateParsed(
    socket: { send(data: string): unknown },
    sessionId: string,
    snapshot: TestSessionSnapshot,
  ) {
    return this.updateParsedSnapshot(socket, sessionId, snapshot);
  }
}

function createState(
  limits: {
    globalPendingCommands?: number;
    perSessionPendingCommands?: number;
    liveSessions?: number;
    aggregateMetadataBytes?: number;
  } = {},
) {
  return new SessionBrokerState<
    TestSessionInfo,
    TestSessionState,
    TestServerMessage,
    TestCommandResult,
    TestListedSession,
    TestSelectedContext,
    TestSessionReview,
    TestCommentSummary
  >(testBrokerView, limits);
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
  test("retains pre-parsed specialized metadata without invoking app parsers again", () => {
    const parseForbiddenView = {
      ...testBrokerView,
      parseRegistration: () => {
        throw new Error("registration reparsed");
      },
      parseSnapshot: () => {
        throw new Error("snapshot reparsed");
      },
    };
    const state = new PreparsedTestBrokerState(parseForbiddenView);
    const socket = { send() {} };
    const registration = createRegistration();
    const initial = createSnapshot();
    const updated = createSnapshot({ selectedIndex: 1 });

    expect(state.registerParsed(socket, registration, initial)).toBe(true);
    expect(state.updateParsed(socket, registration.sessionId, updated)).toBe("updated");
    expect(state.getSession({ sessionId: registration.sessionId }).snapshot).toBe(updated);
  });

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

  test("resolves repo subdirectories to the nearest eligible registered root", () => {
    const outer = createListedSession({ sessionId: "outer", repoRoot: "/repo", cwd: "/repo" });
    const inner = createListedSession({
      sessionId: "inner",
      repoRoot: "/repo/packages/app",
      cwd: "/repo/packages/app",
    });

    expect(
      resolveSessionTarget([outer, inner], {
        repoRoot: "/repo/packages/app/src",
        repoBoundary: "/repo/packages/app",
      }).sessionId,
    ).toBe("inner");
    expect(
      resolveSessionTarget([outer], {
        repoRoot: "/repo/other",
        repoBoundary: "/repo",
      }).sessionId,
    ).toBe("outer");
    expect(() =>
      resolveSessionTarget([outer], {
        repoRoot: "/repo/packages/app/src",
        repoBoundary: "/repo/packages/app",
      }),
    ).toThrow("No active session matches repoRoot");

    // An external adapter may own a nested root inside the nearest bundled
    // boundary. Its active session remains eligible and wins by distance.
    const custom = createListedSession({
      sessionId: "custom",
      repoRoot: "/repo/custom",
      cwd: "/repo/custom",
    });
    expect(
      resolveSessionTarget([outer, custom], {
        repoRoot: "/repo/custom/src",
        repoBoundary: "/repo",
      }).sessionId,
    ).toBe("custom");

    // Older clients omit the boundary; containment fallback remains compatible.
    expect(resolveSessionTarget([outer], { repoRoot: "/repo/packages/app/src" }).sessionId).toBe(
      "outer",
    );
    expect(resolveSessionTarget([outer], { repoRoot: "/repo/..cache" }).sessionId).toBe("outer");
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

    const result = state.updateSnapshot(socket, "session-1", {
      selectedIndex: "oops",
    });

    expect(result).toBe("invalid");
    expect(state.getSession({ sessionId: "session-1" }).snapshot.state.selectedIndex).toBe(0);
  });

  test("rejects snapshot, heartbeat, and command-result mutation from a non-owner socket", async () => {
    const state = createState();
    const sent: string[] = [];
    const owner = {
      send(data: string) {
        sent.push(data);
      },
    };
    const attacker = { send() {} };
    state.registerSession(owner, createRegistration(), createSnapshot());
    expect(state.updateSnapshot(attacker, "session-1", createSnapshot({ selectedIndex: 9 }))).toBe(
      "not-owner",
    );
    expect(state.markSessionSeen(attacker, "session-1")).toBe(false);

    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "src/example.ts", summary: "Review note" },
      timeoutMessage: "Timed out.",
    });
    const requestId = "request-owner";
    const pendingRequestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
    expect(
      state.handleCommandResult(attacker, {
        requestId: pendingRequestId,
        ok: true,
        result: { kind: "annotated", annotationId: "attacker" },
      }),
    ).toBe("not-owner");
    expect(state.getPendingCommandCount()).toBe(1);
    state.handleCommandResult(owner, {
      requestId: pendingRequestId,
      ok: true,
      result: { kind: "annotated", annotationId: requestId },
    });
    await expect(pending).resolves.toMatchObject({ annotationId: requestId });
  });

  test("reports missing sessions separately from invalid snapshot payloads", () => {
    const state = createState();

    expect(
      state.updateSnapshot({ send() {} }, "missing-session", {
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

    state.handleCommandResult(socket, {
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("bounds and releases aggregate live-session metadata across every lifecycle", () => {
    const probe = createState();
    const probeSocket = { send() {} };
    probe.registerSession(probeSocket, createRegistration(), createSnapshot());
    const oneSessionBytes = probe.getAggregateMetadataBytes();
    probe.unregisterSocket(probeSocket);

    const countState = createState({
      liveSessions: 2,
      aggregateMetadataBytes: oneSessionBytes * 10,
    });
    const firstSocket = { send() {} };
    const secondSocket = { send() {} };
    const thirdSocket = { send() {} };
    countState.registerSession(firstSocket, createRegistration(), createSnapshot());
    countState.registerSession(
      secondSocket,
      createRegistration({ sessionId: "session-2", cwd: "/repo/two" }),
      createSnapshot(),
    );
    expect(() =>
      countState.registerSession(
        thirdSocket,
        createRegistration({ sessionId: "session-3", cwd: "/repo/three" }),
        createSnapshot(),
      ),
    ).toThrow(expect.objectContaining({ code: "session-metadata-capacity", scope: "sessions" }));
    expect(countState.getSessionCount()).toBe(2);
    countState.unregisterSocket(firstSocket);
    expect(
      countState.registerSession(
        thirdSocket,
        createRegistration({ sessionId: "session-3", cwd: "/repo/three" }),
        createSnapshot(),
      ),
    ).toBe(true);

    const largeState = createState({ aggregateMetadataBytes: oneSessionBytes * 2 });
    largeState.registerSession({ send() {} }, createRegistration(), createSnapshot());
    const largeRegistration = createRegistration({ sessionId: "session-2", cwd: "/repo/large" });
    largeRegistration.info.files = ["x".repeat(oneSessionBytes * 2)];
    expect(() =>
      largeState.registerSession({ send() {} }, largeRegistration, createSnapshot()),
    ).toThrow(expect.objectContaining({ code: "session-metadata-capacity", scope: "bytes" }));
    expect(largeState.getSessionCount()).toBe(1);

    const byteState = createState({ aggregateMetadataBytes: oneSessionBytes + 32 });
    const socket = { send() {} };
    const registration = createRegistration();
    expect(byteState.registerSession(socket, registration, createSnapshot())).toBe(true);
    const retainedBytes = byteState.getAggregateMetadataBytes();
    expect(
      byteState.updateSnapshot(
        socket,
        registration.sessionId,
        createSnapshot({ updatedAt: "x".repeat(256) }),
      ),
    ).toBe("capacity");
    expect(byteState.getAggregateMetadataBytes()).toBe(retainedBytes);
    expect(byteState.getSession({ sessionId: registration.sessionId }).snapshot.updatedAt).toBe(
      "2026-03-22T00:00:00.000Z",
    );

    expect(byteState.registerSession(socket, registration, createSnapshot())).toBe(true);
    expect(byteState.getAggregateMetadataBytes()).toBe(retainedBytes);
    const oversizedReplacement = createRegistration();
    oversizedReplacement.info.title = "x".repeat(256);
    expect(() => byteState.registerSession(socket, oversizedReplacement, createSnapshot())).toThrow(
      expect.objectContaining({ code: "session-metadata-capacity", scope: "bytes" }),
    );
    expect(byteState.getSession({ sessionId: registration.sessionId }).title).toBe(
      "repo working tree",
    );

    byteState.unregisterSocket(socket);
    expect(byteState.getAggregateMetadataBytes()).toBe(0);
    const reconnectSocket = { send() {} };
    expect(byteState.registerSession(reconnectSocket, registration, createSnapshot())).toBe(true);
    byteState.pruneStaleSessions({ ttlMs: 1, now: Date.now() + 10_000 });
    expect(byteState.getSessionCount()).toBe(0);
    expect(byteState.getAggregateMetadataBytes()).toBe(0);
  });

  test("preserves typed producer capacity failures", async () => {
    const state = createState();
    let requestId = "";
    const socket = {
      send(data: string) {
        requestId = (JSON.parse(data) as { requestId: string }).requestId;
      },
    };
    state.registerSession(socket, createRegistration(), createSnapshot());
    const pending = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate" as const,
      input: { filePath: "src/example.ts", summary: "Review note" },
      timeoutMessage: "Timed out.",
    });
    state.handleCommandResult(socket, {
      requestId,
      ok: false,
      error: "Session command execution capacity exceeded.",
      errorCode: "session-command-capacity",
    });
    await expect(pending).rejects.toMatchObject({
      code: "session-command-capacity",
      scope: "connection",
    });
    expect(state.getPendingCommandCount()).toBe(0);
  });

  test("bounds pending commands globally and per session under a flood", async () => {
    const state = createState({ globalPendingCommands: 2, perSessionPendingCommands: 1 });
    const socketOne = { send() {} };
    const socketTwo = { send() {} };
    state.registerSession(socketOne, createRegistration(), createSnapshot());
    state.registerSession(
      socketTwo,
      createRegistration({ sessionId: "session-2", cwd: "/repo/two" }),
      createSnapshot(),
    );
    const dispatch = (sessionId: string) =>
      state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
        selector: { sessionId },
        command: "annotate",
        input: { filePath: "src/example.ts", summary: "Review note" },
        timeoutMessage: "Timed out.",
      });

    const first = dispatch("session-1");
    await expect(dispatch("session-1")).rejects.toMatchObject({
      code: "session-command-capacity",
      scope: "session",
    });
    const second = dispatch("session-2");
    await expect(dispatch("session-2")).rejects.toMatchObject({
      code: "session-command-capacity",
      scope: "global",
    });
    expect(state.getPendingCommandCount()).toBe(2);

    state.unregisterSocket(socketOne);
    await expect(first).rejects.toThrow("disconnected");
    expect(state.getPendingCommandCount()).toBe(1);
    state.unregisterSocket(socketTwo);
    await expect(second).rejects.toThrow("disconnected");
    expect(state.getPendingCommandCount()).toBe(0);
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

  test("rejects session-id hijacking until the original owner disconnects", async () => {
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

    expect(
      state.registerSession(
        replacementSocket,
        createRegistration(),
        createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
      ),
    ).toBe(false);
    expect(state.ownsSession(originalSocket, "session-1")).toBe(true);
    expect(state.getPendingCommandCount()).toBe(1);

    state.unregisterSocket(originalSocket);
    await expect(pending).rejects.toThrow("disconnected");
    expect(state.registerSession(replacementSocket, createRegistration(), createSnapshot())).toBe(
      true,
    );
    expect(state.ownsSession(replacementSocket, "session-1")).toBe(true);
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

    state.markSessionSeen(socket, "session-1");

    expect(
      state.pruneStaleSessions({
        ttlMs: 50,
        now: Date.now() + 25,
      }),
    ).toBe(0);
    expect(state.listSessions()).toHaveLength(1);
  });

  test("keeps a live session across a wall-clock jump instead of pruning it on the first post-wake sweep", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const lastSeenAt = Date.now();
    const ttlMs = 45_000;
    const wallClockJumpMs = 300_000; // ~5 min sleep, well past the TTL

    // Seed the pre-sleep baseline: one normal-cadence sweep for the jump to be measured against.
    state.pruneStaleSessions({ ttlMs, now: lastSeenAt + 15_000 });

    // On wake the wall clock has jumped far past the TTL in a single sweep; the
    // session had no chance to heartbeat, so it must survive this first post-wake sweep.
    expect(state.pruneStaleSessions({ ttlMs, now: lastSeenAt + wallClockJumpMs })).toBe(0);
    expect(state.listSessions()).toHaveLength(1);
  });

  test("still prunes a session that stays silent after the post-wake grace sweep", () => {
    const state = createState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const lastSeenAt = Date.now();
    const ttlMs = 45_000;
    const wallClockJumpMs = 300_000; // ~5 min sleep, well past the TTL

    state.pruneStaleSessions({ ttlMs, now: lastSeenAt + 15_000 });
    state.pruneStaleSessions({ ttlMs, now: lastSeenAt + wallClockJumpMs }); // forgiven wake sweep

    // A genuinely gone session never heartbeats again, so the next normal sweep
    // still reaps it — the wake grace is one sweep, not immortality.
    expect(state.pruneStaleSessions({ ttlMs, now: lastSeenAt + wallClockJumpMs + 15_000 })).toBe(1);
    expect(state.listSessions()).toHaveLength(0);
  });
});
