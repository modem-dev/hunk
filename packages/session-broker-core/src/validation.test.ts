import { describe, expect, test } from "bun:test";
import {
  BrokerProtocolError,
  parseBrokerAppId,
  parseBrokerAppPayload,
  parseBrokerDeadline,
  parseBrokerIdentifier,
  parseBrokerRevision,
  parseBrokerSelector,
  parseBrokerTimeout,
  parseBrokerUint64,
  parseExactBrokerRecord,
} from "./validation";

function code(task: () => unknown) {
  try {
    task();
    return null;
  } catch (error) {
    return error instanceof BrokerProtocolError ? error.code : "unexpected";
  }
}

describe("session broker runtime validation", () => {
  test("requires exact plain records and strict optional fields", () => {
    for (const value of [null, [], "record", { required: 1, extra: true }]) {
      expect(code(() => parseExactBrokerRecord(value, ["required"] as const))).not.toBeNull();
    }
    expect(parseExactBrokerRecord({ required: 1 }, ["required"] as const)).toEqual({ required: 1 });
    expect(code(() => parseBrokerSelector({ sessionId: "session-1", extra: true }))).toBe(
      "invalid-keys",
    );
    expect(code(() => parseBrokerSelector({ repoRoot: null }))).toBe("invalid-field");
  });

  test("bounds identifiers, revisions, uint64 values, and deadlines", () => {
    expect(parseBrokerAppId("dev.hunk")).toBe("dev.hunk");
    expect(parseBrokerIdentifier("session-1")).toBe("session-1");
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(code(() => parseBrokerRevision(value))).toBe("invalid-contract");
    }
    expect(parseBrokerUint64("18446744073709551615")).toBe("18446744073709551615");
    expect(code(() => parseBrokerUint64("01"))).toBe("invalid-field");
    expect(parseBrokerTimeout(300_000)).toBe(300_000);
    expect(code(() => parseBrokerTimeout(300_001))).toBe("invalid-deadline");
    expect(code(() => parseBrokerDeadline(Infinity))).toBe("invalid-deadline");
  });

  test("redacts app parser rejection and exceptions", () => {
    expect(code(() => parseBrokerAppPayload(() => null, {}))).toBe("invalid-app-payload");
    expect(
      code(() =>
        parseBrokerAppPayload(() => {
          throw new Error("secret parser internals");
        }, {}),
      ),
    ).toBe("app-parser-failed");
    try {
      parseBrokerAppPayload(() => {
        throw new Error("secret parser internals");
      }, {});
    } catch (error) {
      expect(String(error)).not.toContain("secret parser internals");
      expect((error as Error).stack).not.toContain("secret parser internals");
    }
  });
});
