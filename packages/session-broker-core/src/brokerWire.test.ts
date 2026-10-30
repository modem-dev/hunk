import { describe, expect, test } from "bun:test";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "./brokerWire";

describe("session broker wire parsing", () => {
  test("registration requires the current websocket registration version", () => {
    expect(
      parseSessionRegistrationEnvelope(
        {
          registrationVersion: SESSION_BROKER_REGISTRATION_VERSION - 1,
          sessionId: "session-1",
          pid: 123,
          cwd: "/repo",
          launchedAt: "2026-03-22T00:00:00.000Z",
          info: { ok: true },
        },
        (value) => (value && typeof value === "object" ? value : null),
      ),
    ).toBeNull();
  });

  test("rejects arrays, unknown keys, malformed optionals, and throwing app parsers", () => {
    const valid = {
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: { ok: true },
    };
    const parseInfo = (value: unknown) => (value && typeof value === "object" ? value : null);
    for (const value of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, repoRoot: null },
      { ...valid, terminal: { locations: [], extra: true } },
      { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, sessionId: "bad id!" },
    ]) {
      expect(parseSessionRegistrationEnvelope(value, parseInfo)).toBeNull();
    }
    expect(
      parseSessionRegistrationEnvelope(valid, () => {
        throw new Error("parser internals");
      }),
    ).toBeNull();
    expect(
      parseSessionSnapshotEnvelope({ updatedAt: "now", state: {}, extra: true }, parseInfo),
    ).toBeNull();
  });

  test("accepts terminal-native session identifiers without treating them as broker ids", () => {
    const registration = parseSessionRegistrationEnvelope(
      {
        registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
        sessionId: "session-1",
        pid: 123,
        cwd: "/repo",
        launchedAt: "2026-03-22T00:00:00.000Z",
        terminal: {
          locations: [{ source: "iterm2", sessionId: "w1t2p3:ABCDEF" }],
        },
        info: { ok: true },
      },
      (value) => (value && typeof value === "object" ? value : null),
    );

    expect(registration?.terminal?.locations).toEqual([
      { source: "iterm2", sessionId: "w1t2p3:ABCDEF" },
    ]);
  });

  test("rejects prototype-shaped registration and terminal metadata extras", () => {
    const parseInfo = (value: unknown) => (value && typeof value === "object" ? value : null);
    const registration = {
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: { ok: true },
    } as Record<string, unknown>;
    Object.defineProperty(registration, "constructor", {
      configurable: true,
      enumerable: true,
      value: "unexpected",
    });
    expect(parseSessionRegistrationEnvelope(registration, parseInfo)).toBeNull();

    const terminal = { locations: [] } as Record<string, unknown>;
    Object.defineProperty(terminal, "toString", {
      configurable: true,
      enumerable: true,
      value: "unexpected",
    });
    expect(
      parseSessionRegistrationEnvelope(
        {
          registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
          sessionId: "session-1",
          pid: 123,
          cwd: "/repo",
          launchedAt: "2026-03-22T00:00:00.000Z",
          terminal,
          info: { ok: true },
        },
        parseInfo,
      ),
    ).toBeNull();
  });

  test("snapshot parsing delegates opaque app state validation", () => {
    const snapshot = parseSessionSnapshotEnvelope(
      {
        updatedAt: "2026-03-22T00:00:00.000Z",
        state: { mode: "review", selected: 2 },
      },
      (value) => {
        if (!value || typeof value !== "object") {
          return null;
        }

        const mode = (value as { mode?: unknown }).mode;
        const selected = (value as { selected?: unknown }).selected;
        return mode === "review" && typeof selected === "number" ? { mode, selected } : null;
      },
    );

    expect(snapshot).toEqual({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: { mode: "review", selected: 2 },
    });
  });
});
