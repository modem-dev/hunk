import { describe, expect, test } from "bun:test";
import {
  SessionBrokerState,
  resolveSessionTarget,
  type SessionBrokerListedSession,
  type SessionBrokerViewAdapter,
} from "./brokerState";
import type { SessionBrokerLimitOptions } from "./budgets";
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
  TestCommentSummary,
  TestServerMessage,
  TestCommandResult
> = {
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseTestInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseTestState),
  parseCommandInput: (_command, _version, value) => value,
  parseCommandResult: (_command, _version, value) =>
    value && typeof value === "object" ? (value as TestCommandResult) : null,
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

function createState(limitOptions: SessionBrokerLimitOptions = {}) {
  return new SessionBrokerState<
    TestSessionInfo,
    TestSessionState,
    TestServerMessage,
    TestCommandResult,
    TestListedSession,
    TestSelectedContext,
    TestSessionReview,
    TestCommentSummary
  >(testBrokerView, limitOptions);
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
  test("keeps shutdown terminal against registration and command re-admission", () => {
    const state = createState();
    const socket = { send() {} };
    const shutdownError = new Error("terminal shutdown");
    state.shutdown(shutdownError);
    state.shutdown(new Error("ignored second shutdown"));

    expect(state.registerSession(socket, createRegistration(), createSnapshot())).toBe("shutdown");
    expect(state.getSessionCount()).toBe(0);
    expect(() =>
      state.dispatchCommand({
        selector: { sessionId: "session-1" },
        command: "annotate",
        input: { filePath: "a.ts", summary: "late" },
        timeoutMessage: "timeout",
      }),
    ).toThrow(shutdownError);
    expect(state.getPendingCommandCount()).toBe(0);
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

    expect(state.registerSession(socket, createRegistration(), createSnapshot())).toBe(
      "registered",
    );
    const accepted = state.registerSession(
      socket,
      {
        ...createRegistration(),
        registrationVersion: 0,
      },
      createSnapshot(),
    );

    expect(accepted).toBe("invalid");
    expect(state.listSessions()).toHaveLength(1);
    expect(state.getSession({ sessionId: "session-1" }).snapshot.state.selectedIndex).toBe(0);
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

  test("rejects snapshot and heartbeat assertions from an unregistered peer", () => {
    const state = createState();
    const socket = { send() {} };

    expect(state.updateSnapshot(socket, "missing-session", createSnapshot())).toBe("not-owner");
    expect(state.markSessionSeen(socket, "missing-session")).toBe("not-owner");
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

  test("rejects cross-peer mutation and leaves the owner's command pending", async () => {
    const state = createState();
    const ownerSent: string[] = [];
    const owner = {
      send(data: string) {
        ownerSent.push(data);
      },
    };
    const other = { send() {} };

    state.registerSession(owner, createRegistration(), createSnapshot());
    state.registerSession(
      other,
      createRegistration({ sessionId: "session-2", cwd: "/other", repoRoot: "/other" }),
      createSnapshot(),
    );

    expect(
      state.updateSnapshot(
        other,
        "session-1",
        createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z", selectedIndex: 1 }),
      ),
    ).toBe("not-owner");
    expect(state.markSessionSeen(other, "session-1")).toBe("not-owner");
    expect(state.getSession({ sessionId: "session-1" }).snapshot.state.selectedIndex).toBe(0);

    const pending = state.dispatchCommand<{ kind: "annotated"; annotationId: string }, "annotate">({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "src/example.ts", summary: "Review note" },
      timeoutMessage: "Timed out waiting for the session to apply the note.",
    });
    const outgoing = JSON.parse(ownerSent[0]!) as { requestId: string };

    expect(
      state.handleCommandResult(other, {
        requestId: outgoing.requestId,
        ok: true,
        result: { kind: "annotated", annotationId: "forged" },
      }),
    ).toBe("not-owner");
    expect(state.getPendingCommandCount()).toBe(1);

    expect(
      state.handleCommandResult(owner, {
        requestId: outgoing.requestId,
        ok: true,
        result: { kind: "annotated", annotationId: "owned" },
      }),
    ).toBe("handled");
    await expect(pending).resolves.toEqual({ kind: "annotated", annotationId: "owned" });
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

  test("rejects a second live peer and allows reconnect only after the owner closes", () => {
    const state = createState();
    const originalSocket = { send() {} };
    const replacementSocket = { send() {} };

    expect(state.registerSession(originalSocket, createRegistration(), createSnapshot())).toBe(
      "registered",
    );
    expect(
      state.registerSession(
        replacementSocket,
        createRegistration(),
        createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
      ),
    ).toBe("already-connected");
    expect(state.listSessions()[0]?.snapshot.updatedAt).toBe("2026-03-22T00:00:00.000Z");

    state.unregisterSocket(originalSocket);

    expect(
      state.registerSession(
        replacementSocket,
        createRegistration(),
        createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
      ),
    ).toBe("registered");
    expect(state.listSessions()[0]?.snapshot.updatedAt).toBe("2026-03-22T00:00:01.000Z");
    expect(state.updateSnapshot(originalSocket, "session-1", createSnapshot())).toBe("not-owner");
    expect(state.markSessionSeen(originalSocket, "session-1")).toBe("not-owner");

    // A delayed close callback from the retired transport cannot unregister its replacement.
    state.unregisterSocket(originalSocket);
    expect(state.listSessions()).toHaveLength(1);
  });

  test("atomically replaces a live owner without leaking the replacement socket's prior reservations", () => {
    const registration = createRegistration();
    const snapshot = createSnapshot();
    const retainedBytes =
      new TextEncoder().encode(JSON.stringify({ registration, snapshot })).byteLength + 256;
    const expandedRegistration = createRegistration({
      info: { ...registration.info, title: "x".repeat(64) },
    });
    const expandedBytes =
      new TextEncoder().encode(
        JSON.stringify({
          registration: expandedRegistration,
          snapshot: createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
        }),
      ).byteLength + 256;
    const state = createState({
      limits: {
        maxSessions: 2,
        maxRetainedSessionBytes: expandedBytes,
        maxRetainedBytes: retainedBytes * 2,
      },
    });
    const originalSocket = { send() {} };
    const replacementSocket = { send() {} };
    state.registerSession(originalSocket, registration, snapshot);
    state.registerSession(
      replacementSocket,
      createRegistration({ sessionId: "session-2" }),
      snapshot,
    );

    expect(
      state.registerSession(
        replacementSocket,
        expandedRegistration,
        createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
        { replaceOwner: true },
      ),
    ).toBe("registered");
    expect(state.markSessionSeen(originalSocket, "session-1")).toBe("not-owner");
    expect(state.markSessionSeen(replacementSocket, "session-1")).toBe("seen");
    state.unregisterSocket(originalSocket);
    expect(state.listSessions()).toHaveLength(1);
  });

  test("releases the replacement socket's prior session count reservation", () => {
    const state = createState({ limits: { maxSessions: 2 } });
    const originalSocket = { send() {} };
    const replacementSocket = { send() {} };
    const thirdSocket = { send() {} };
    state.registerSession(originalSocket, createRegistration(), createSnapshot());
    state.registerSession(
      replacementSocket,
      createRegistration({ sessionId: "session-2" }),
      createSnapshot(),
    );
    expect(
      state.registerSession(replacementSocket, createRegistration(), createSnapshot(), {
        replaceOwner: true,
      }),
    ).toBe("registered");
    expect(
      state.registerSession(
        thirdSocket,
        createRegistration({ sessionId: "session-3" }),
        createSnapshot(),
      ),
    ).toBe("registered");
    expect(state.listSessions()).toHaveLength(2);
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

    expect(state.markSessionSeen(socket, "session-1")).toBe("seen");

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

  test("schedules commands FIFO with one active command per session", async () => {
    const state = createState();
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) };
    state.registerSession(socket, createRegistration(), createSnapshot());

    const first = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "a", summary: "first" },
      timeoutMessage: "first timeout",
    });
    const second = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "b", summary: "second" },
      timeoutMessage: "second timeout",
    });
    expect(sent).toHaveLength(1);
    const firstId = JSON.parse(sent[0]!).requestId as string;
    state.handleCommandResult(socket, {
      requestId: firstId,
      ok: true,
      result: { kind: "annotated", annotationId: "one" },
    });
    expect(sent).toHaveLength(2);
    const secondId = JSON.parse(sent[1]!).requestId as string;
    state.handleCommandResult(socket, {
      requestId: secondId,
      ok: true,
      result: { kind: "annotated", annotationId: "two" },
    });
    await expect(first).resolves.toMatchObject({ annotationId: "one" });
    await expect(second).resolves.toMatchObject({ annotationId: "two" });
  });

  test("lets different sessions progress independently", async () => {
    const state = createState();
    const firstSent: string[] = [];
    const secondSent: string[] = [];
    const firstSocket = { send: (data: string) => firstSent.push(data) };
    const secondSocket = { send: (data: string) => secondSent.push(data) };
    state.registerSession(firstSocket, createRegistration(), createSnapshot());
    state.registerSession(
      secondSocket,
      createRegistration({ sessionId: "session-2", cwd: "/two", repoRoot: "/two" }),
      createSnapshot(),
    );
    const first = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "a", summary: "one" },
      timeoutMessage: "timeout",
    });
    const second = state.dispatchCommand({
      selector: { sessionId: "session-2" },
      command: "annotate",
      input: { filePath: "b", summary: "two" },
      timeoutMessage: "timeout",
    });
    expect([firstSent.length, secondSent.length]).toEqual([1, 1]);
    for (const [socket, raw, pending, id] of [
      [firstSocket, firstSent[0]!, first, "one"],
      [secondSocket, secondSent[0]!, second, "two"],
    ] as const) {
      state.handleCommandResult(socket, {
        requestId: JSON.parse(raw).requestId,
        ok: true,
        result: { kind: "annotated", annotationId: id },
      });
      await expect(pending).resolves.toMatchObject({ annotationId: id });
    }
  });

  test("rejects exact count boundaries plus one without dropping admitted work", async () => {
    const state = createState({
      limits: { maxCommandsPerSession: 2, maxCommandsTotal: 2 },
    });
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) };
    state.registerSession(socket, createRegistration(), createSnapshot());
    const commands = ["one", "two"].map((summary) =>
      state.dispatchCommand({
        selector: { sessionId: "session-1" },
        command: "annotate",
        input: { filePath: "a", summary },
        timeoutMessage: "timeout",
      }),
    );
    expect(() =>
      state.dispatchCommand({
        selector: { sessionId: "session-1" },
        command: "annotate",
        input: { filePath: "a", summary: "three" },
        timeoutMessage: "timeout",
      }),
    ).toThrow("queue-full");
    state.shutdown();
    for (const command of commands) await expect(command).rejects.toThrow("shut down");
  });

  test("accounts queued command UTF-8 bytes at the exact daemon boundary", async () => {
    const input = { filePath: "é", summary: "😀" };
    const bytes =
      new TextEncoder().encode(
        JSON.stringify({
          type: "command",
          requestId: "0".repeat(36),
          command: "annotate",
          commandVersion: 1,
          input,
        }),
      ).byteLength + 128;
    const state = createState({ limits: { maxQueuedCommandBytes: bytes } });
    const socket = { send() {} };
    state.registerSession(socket, createRegistration(), createSnapshot());
    const admitted = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input,
      timeoutMessage: "timeout",
    });
    expect(() =>
      state.dispatchCommand({
        selector: { sessionId: "session-1" },
        command: "annotate",
        input,
        timeoutMessage: "timeout",
      }),
    ).toThrow("queue-full");
    state.shutdown();
    await expect(admitted).rejects.toThrow("shut down");
  });

  test("releases a timed-out active command and advances its session FIFO", async () => {
    const state = createState({ limits: { defaultCommandTimeoutMs: 5, maxCommandTimeoutMs: 100 } });
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) };
    state.registerSession(socket, createRegistration(), createSnapshot());
    const first = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "a", summary: "one" },
      timeoutMessage: "timed out",
    });
    const second = state.dispatchCommand({
      selector: { sessionId: "session-1" },
      command: "annotate",
      input: { filePath: "b", summary: "two" },
      timeoutMessage: "second timeout",
      timeoutMs: 100,
    });
    await expect(first).rejects.toThrow("timed out");
    expect(sent).toHaveLength(2);
    state.handleCommandResult(socket, {
      requestId: JSON.parse(sent[1]!).requestId,
      ok: true,
      result: { kind: "annotated", annotationId: "two" },
    });
    await expect(second).resolves.toMatchObject({ annotationId: "two" });
    expect(() =>
      state.dispatchCommand({
        selector: { sessionId: "session-1" },
        command: "annotate",
        input: { filePath: "c", summary: "three" },
        timeoutMessage: "timeout",
        timeoutMs: 101,
      }),
    ).toThrow("capacity-exceeded");
  });

  test("rejects a new session at capacity without evicting the existing owner", () => {
    const state = createState({ limits: { maxSessions: 1 } });
    const first = { send() {} };
    const second = { send() {} };
    expect(state.registerSession(first, createRegistration(), createSnapshot())).toBe("registered");
    expect(
      state.registerSession(
        second,
        createRegistration({ sessionId: "session-2" }),
        createSnapshot(),
      ),
    ).toBe("capacity-exceeded");
    expect(state.listSessions().map((session) => session.sessionId)).toEqual(["session-1"]);
  });

  test("transfers a same-socket count reservation when the session id changes at capacity", () => {
    const state = createState({ limits: { maxSessions: 1 } });
    const socket = { send() {} };
    expect(state.registerSession(socket, createRegistration(), createSnapshot())).toBe(
      "registered",
    );
    expect(
      state.registerSession(
        socket,
        createRegistration({ sessionId: "session-2", cwd: "/two", repoRoot: "/two" }),
        createSnapshot(),
      ),
    ).toBe("registered");
    expect(state.listSessions().map((session) => session.sessionId)).toEqual(["session-2"]);
  });

  test("accepts identical registration and snapshot replacement at the exact retained ceiling", () => {
    const registration = createRegistration();
    const snapshot = createSnapshot();
    const retainedBytes =
      new TextEncoder().encode(JSON.stringify({ registration, snapshot })).byteLength + 256;
    const state = createState({
      limits: { maxRetainedSessionBytes: retainedBytes, maxRetainedBytes: retainedBytes },
    });
    const socket = { send() {} };
    expect(state.registerSession(socket, registration, snapshot)).toBe("registered");
    expect(state.registerSession(socket, registration, snapshot)).toBe("registered");
    expect(state.updateSnapshot(socket, "session-1", snapshot)).toBe("updated");
  });

  test("preserves retained state and reuses capacity after a replacement cannot reserve", () => {
    const registration = createRegistration();
    const snapshot = createSnapshot();
    const retainedBytes =
      new TextEncoder().encode(JSON.stringify({ registration, snapshot })).byteLength + 256;
    const state = createState({
      limits: { maxRetainedSessionBytes: retainedBytes, maxRetainedBytes: retainedBytes },
    });
    const socket = { send() {} };
    expect(state.registerSession(socket, registration, snapshot)).toBe("registered");
    expect(
      state.updateSnapshot(socket, "session-1", {
        ...snapshot,
        state: { selectedIndex: 123_456, noteCount: 0 },
      }),
    ).toBe("capacity-exceeded");
    expect(state.getSession({ sessionId: "session-1" }).snapshot.state.selectedIndex).toBe(0);
    expect(state.updateSnapshot(socket, "session-1", snapshot)).toBe("updated");
    state.unregisterSocket(socket);
    expect(
      state.registerSession(
        { send() {} },
        createRegistration({ sessionId: "session-2" }),
        snapshot,
      ),
    ).toBe("registered");
  });
});
