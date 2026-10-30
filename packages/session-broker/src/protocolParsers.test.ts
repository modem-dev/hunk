import { describe, expect, test } from "bun:test";
import {
  BrokerProtocolError,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import type { SessionBrokerDaemonRequest } from "./types";
import {
  createSessionBrokerProtocolParsers,
  type StructuralSessionBrokerDaemonRequest,
} from "./protocolParsers";

type TestMessage = SessionServerMessage<"annotate", { summary: string }>;
type TestResult = { applied: true };

function exactObject(value: unknown, keys: readonly string[]) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

const parsers = createSessionBrokerProtocolParsers<
  { title: string },
  { selected: number },
  TestMessage,
  TestResult
>({
  appRevision: 7,
  features: [],
  parseRegistration: (value) =>
    exactObject(value, ["registrationVersion", "sessionId", "pid", "cwd", "launchedAt", "info"])
      ? (value as SessionRegistration<{ title: string }>)
      : null,
  parseSnapshot: (value) =>
    exactObject(value, ["updatedAt", "state"])
      ? (value as SessionSnapshot<{ selected: number }>)
      : null,
  commands: [
    {
      command: "annotate",
      version: 2,
      parseInput: (value) =>
        exactObject(value, ["summary"]) &&
        typeof (value as Record<string, unknown>).summary === "string"
          ? { summary: (value as Record<string, string>).summary! }
          : null,
      parseResult: (value) =>
        exactObject(value, ["applied"]) && (value as Record<string, unknown>).applied === true
          ? { applied: true }
          : null,
    },
  ],
});

const generatedMalformedValues = Array.from({ length: 12 }, (_, index) => {
  const values: unknown[] = [null, false, index + 0.5, `bad value ${index}`, [], { extra: index }];
  return values[index % values.length];
});

const malformedCorpus: readonly unknown[] = [
  ...generatedMalformedValues,
  null,
  [],
  "message",
  {},
  { type: "command", requestId: "request-1", command: "annotate", input: null },
  {
    type: "command",
    requestId: "request-1",
    command: "annotate",
    commandVersion: 0,
    input: { summary: "note" },
  },
  {
    type: "command",
    requestId: "request-1",
    command: "annotate",
    commandVersion: 2,
    input: { summary: "note", extra: true },
  },
  {
    type: "command",
    requestId: "bad id!",
    command: "annotate",
    commandVersion: 2,
    input: { summary: "note" },
  },
  {
    type: "command",
    requestId: "request-1",
    command: "mismatched",
    commandVersion: 2,
    input: { summary: "note" },
  },
  { type: "register", registration: null, snapshot: {}, extra: true },
  { type: "snapshot", sessionId: "bad id!", snapshot: {} },
  {
    action: "dispatch",
    selector: { nested: true },
    command: "annotate",
    input: { summary: 1 },
  },
  { action: "get", selector: { sessionId: "session-1", nested: true } },
  { action: "list", selector: {} },
];

function failureCode(task: () => unknown) {
  try {
    task();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerProtocolError);
    return (error as BrokerProtocolError).code;
  }
}

describe("session broker authoritative protocol parsers", () => {
  test("type-locks complete parser outputs to the public unions", () => {
    const client = parsers.parseClientMessage({
      type: "heartbeat",
      sessionId: "session-1",
    });
    const server: TestMessage = parsers.parseServerMessage({
      type: "command",
      requestId: "request-1",
      command: "annotate",
      commandVersion: 2,
      input: { summary: "note" },
    });
    const request: StructuralSessionBrokerDaemonRequest<"annotate"> = parsers.parseDaemonRequest({
      action: "list",
    });
    const publicRequest: SessionBrokerDaemonRequest<"annotate"> = {
      action: "list",
    };
    expect([client.type, server.command, request.action, publicRequest.action]).toEqual([
      "heartbeat",
      "annotate",
      "list",
      "list",
    ]);
  });

  test("runs one deterministic malformed corpus through websocket and HTTP parsers", () => {
    for (const value of malformedCorpus) {
      expect(failureCode(() => parsers.parseServerMessage(value))).not.toBeNull();
      expect(failureCode(() => parsers.parseClientMessage(value))).not.toBeNull();
      expect(failureCode(() => parsers.parseDaemonRequest(value))).not.toBeNull();
    }
  });

  test("rejects unsupported dispatch controls instead of accepting and discarding them", () => {
    const dispatch = {
      action: "dispatch",
      selector: { sessionId: "session-1" },
      command: "annotate",
      commandVersion: 2,
      input: { summary: "note" },
    } as const;
    for (const control of [{ deadline: 1 }, { idempotencyKey: "request-key-1" }]) {
      expect(failureCode(() => parsers.parseDaemonRequest({ ...dispatch, ...control }))).toBe(
        "invalid-keys",
      );
    }
  });

  test("enforces complete client envelopes and exact app result contracts", () => {
    expect(
      failureCode(() =>
        parsers.parseClientMessage({
          type: "heartbeat",
          sessionId: "session-1",
          extra: true,
        }),
      ),
    ).toBe("invalid-keys");
    expect(failureCode(() => parsers.parseCommandResult("annotate", 2, { applied: false }))).toBe(
      "invalid-app-payload",
    );
    expect(failureCode(() => parsers.parseCommandResult("annotate", 1, { applied: true }))).toBe(
      "unknown-command",
    );
  });

  test("rejects prototype-shaped extras across producer, bridge, and HTTP envelopes", () => {
    const validValues = [
      {
        parse: (value: unknown) => parsers.parseClientMessage(value),
        value: { type: "heartbeat", sessionId: "session-1" },
      },
      {
        parse: (value: unknown) => parsers.parseServerMessage(value),
        value: {
          type: "command",
          requestId: "request-1",
          command: "annotate",
          commandVersion: 2,
          input: { summary: "note" },
        },
      },
      {
        parse: (value: unknown) => parsers.parseDaemonRequest(value),
        value: { action: "list" },
      },
    ] as const;

    for (const { parse, value } of validValues) {
      for (const key of ["__proto__", "constructor", "toString"]) {
        const malformed = { ...value } as Record<string, unknown>;
        Object.defineProperty(malformed, key, {
          configurable: true,
          enumerable: true,
          value: true,
        });
        expect(failureCode(() => parse(malformed))).toBe("invalid-keys");
      }
    }
  });

  test("rejects exotic envelope prototypes and accepts null-prototype records", () => {
    class HeartbeatEnvelope {
      type = "heartbeat" as const;
      sessionId = "session-1";
    }
    const inherited = Object.create({ type: "heartbeat", sessionId: "session-1" }) as Record<
      string,
      unknown
    >;
    const customPrototype = Object.assign(Object.create({ inherited: true }), {
      type: "heartbeat",
      sessionId: "session-1",
    });
    for (const value of [new HeartbeatEnvelope(), inherited, customPrototype]) {
      expect(failureCode(() => parsers.parseClientMessage(value))).toBe("invalid-record");
    }

    const heartbeat = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: "heartbeat",
      sessionId: "session-1",
    });
    const list = Object.assign(Object.create(null) as Record<string, unknown>, { action: "list" });
    expect(parsers.parseClientMessage(heartbeat)).toEqual({
      type: "heartbeat",
      sessionId: "session-1",
    });
    expect(parsers.parseDaemonRequest(list)).toEqual({ action: "list" });
  });

  test("leaves registration and snapshot app payloads untouched for controller parsing", () => {
    const registration = { malformedForApp: true };
    const snapshot = { transformedLater: true };
    expect(parsers.parseClientMessage({ type: "register", registration, snapshot })).toEqual({
      type: "register",
      registration,
      snapshot,
    });
  });

  test("normalizes parser throws without exposing their messages", () => {
    const throwing = createSessionBrokerProtocolParsers({
      appRevision: 1,
      features: [],
      parseRegistration: () => {
        throw new Error("registration secret");
      },
      parseSnapshot: () => null,
      commands: [],
    });
    expect(failureCode(() => throwing.parseRegistration({}))).toBe("app-parser-failed");
  });
});
