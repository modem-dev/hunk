import { describe, expect, test } from "bun:test";
import {
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../test/helpers/mcp-fixtures";
import { HunkDaemonState } from "./daemonState";

function createRegistration(overrides = {}) {
  return createTestSessionRegistration({
    inputKind: "diff",
    launchedAt: "2026-03-23T00:00:00.000Z",
    pid: 1234,
    reviewFiles: [],
    sessionId: "test-session",
    title: "repo diff",
    ...overrides,
  });
}

function createSnapshot() {
  return createTestSessionSnapshot({
    selectedFileId: undefined,
    selectedFilePath: undefined,
    updatedAt: "2026-03-23T00:00:00.000Z",
  });
}

function createMockSocket() {
  return { send: () => {} };
}

describe("session registration terminal metadata", () => {
  test("daemon state accepts legacy file registrations after a daemon restart", () => {
    const state = new HunkDaemonState();
    const reviewFile = {
      id: "file-1",
      path: "README.md",
      additions: 1,
      deletions: 0,
      hunkCount: 1,
      hunks: [],
    };

    state.registerSession(
      createMockSocket(),
      {
        ...createRegistration(),
        // Simulate an older TUI reconnecting to a freshly restarted daemon.
        protocolVersion: undefined,
        reviewFiles: undefined,
        files: [reviewFile],
      } as never,
      createSnapshot(),
    );

    const sessions = state.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      fileCount: 1,
      files: [
        {
          path: "README.md",
        },
      ],
    });
  });

  test("daemon state passes generic terminal metadata through to listed sessions", () => {
    const state = new HunkDaemonState();
    const registration = createRegistration({
      terminal: {
        program: "iTerm.app",
        locations: [
          { source: "tty", tty: "/dev/ttys003" },
          { source: "tmux", paneId: "%2" },
          {
            source: "iterm2",
            windowId: "1",
            tabId: "2",
            paneId: "3",
            sessionId: "w1t2p3:ABC",
          },
        ],
      },
    });

    state.registerSession(createMockSocket(), registration, createSnapshot());

    const sessions = state.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.terminal).toEqual(registration.terminal);
  });

  test("daemon state omits terminal metadata when nothing is known", () => {
    const state = new HunkDaemonState();
    const registration = createRegistration();

    state.registerSession(createMockSocket(), registration, createSnapshot());

    const sessions = state.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.terminal).toBeUndefined();
  });
});
