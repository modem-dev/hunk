import { describe, expect, test } from "bun:test";
import {
  MAX_GENERATION_IDENTIFIER_BYTES,
  MAX_GENERATION_IDENTIFIER_CHARACTERS,
  SESSION_BROKER_REGISTRATION_VERSION,
  parseGenerationIdentifier,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "./brokerWire";

describe("session broker wire parsing", () => {
  test("generation identifiers use one compact ASCII wire syntax", () => {
    expect(parseGenerationIdentifier("generation:0123-ab_CD.9")).toBe("generation:0123-ab_CD.9");
    expect(
      parseGenerationIdentifier("g".repeat(MAX_GENERATION_IDENTIFIER_CHARACTERS)),
    ).not.toBeNull();
    expect(
      parseGenerationIdentifier("g".repeat(MAX_GENERATION_IDENTIFIER_CHARACTERS + 1)),
    ).toBeNull();
    expect(parseGenerationIdentifier("g".repeat(300 * 1024))).toBeNull();
    expect(parseGenerationIdentifier("generation with spaces")).toBeNull();
    expect(parseGenerationIdentifier("generation:💥")).toBeNull();
    expect(MAX_GENERATION_IDENTIFIER_BYTES).toBe(MAX_GENERATION_IDENTIFIER_CHARACTERS);
  });

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
