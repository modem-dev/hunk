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
