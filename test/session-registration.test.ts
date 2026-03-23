import { describe, expect, test } from "bun:test";
import { HunkDaemonState } from "../src/mcp/daemonState";
import type { HunkSessionRegistration, HunkSessionSnapshot } from "../src/mcp/types";

function createRegistration(
  overrides: Partial<HunkSessionRegistration> = {},
): HunkSessionRegistration {
  return {
    sessionId: "test-session",
    pid: 1234,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "diff",
    title: "repo diff",
    sourceLabel: "/repo",
    launchedAt: "2026-03-23T00:00:00.000Z",
    files: [],
    ...overrides,
  };
}

function createSnapshot(): HunkSessionSnapshot {
  return {
    selectedFileId: undefined,
    selectedFilePath: undefined,
    selectedHunkIndex: 0,
    showAgentNotes: false,
    liveCommentCount: 0,
    liveComments: [],
    updatedAt: "2026-03-23T00:00:00.000Z",
  };
}

function createMockSocket() {
  return { send: () => {} };
}

describe("session registration tty metadata", () => {
  test("daemon state passes tty and tmuxPane through to listed sessions", () => {
    const state = new HunkDaemonState();
    const registration = createRegistration({
      tty: "/dev/ttys003",
      tmuxPane: "%2",
    });

    state.registerSession(createMockSocket(), registration, createSnapshot());

    const sessions = state.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tty).toBe("/dev/ttys003");
    expect(sessions[0]!.tmuxPane).toBe("%2");
  });

  test("daemon state omits tty and tmuxPane when not set", () => {
    const state = new HunkDaemonState();
    const registration = createRegistration();

    state.registerSession(createMockSocket(), registration, createSnapshot());

    const sessions = state.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tty).toBeUndefined();
    expect(sessions[0]!.tmuxPane).toBeUndefined();
  });
});
