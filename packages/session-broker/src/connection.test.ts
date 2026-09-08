import { describe, expect, test } from "bun:test";
import type {
  ProducerGrant,
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
} from "@hunk/session-broker-core";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  SESSION_BROKER_SIGNATURE_ALGORITHM,
} from "@hunk/session-broker-core";
import { SessionBrokerAuthenticator } from "./authentication";
import {
  SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE,
  createSessionBrokerConnection,
  type SessionBrokerConnection,
} from "./connection";
import { webSessionBrokerCrypto } from "./crypto";
import { createSessionBrokerProtocolParsers } from "./protocolParsers";
import type { SessionBrokerSocketLike } from "./types";
import { DeterministicLifecycleClockTest } from "../../../test/helpers/lifecycleClockTest";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

type TestServerMessage = SessionServerMessage<"annotate", { summary: string }>;
type TestConnection = SessionBrokerConnection<
  TestSessionInfo,
  TestSessionState,
  TestSocket,
  TestServerMessage,
  { ok: true }
>;

class TestSocket implements SessionBrokerSocketLike {
  readyState = 0;
  sent: string[] = [];
  throwOnSend = false;
  throwOnNextSend: unknown = null;
  lastClose: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    if (this.throwOnSend) throw new Error("socket exploded");
    if (this.throwOnNextSend !== null) {
      const error = this.throwOnNextSend;
      this.throwOnNextSend = null;
      throw error;
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.lastClose = { code, reason };
    this.emitClose(code, reason);
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data });
  }

  emitClose(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Keep close pending so tests can settle foreign authentication before the close callback. */
class DeferredCloseSocketTest extends TestSocket {
  override close(code?: number, reason?: string) {
    this.lastClose = { code, reason };
  }
}

/** Throw from selected one-shot schedules while retaining deterministic retry time. */
class ThrowingScheduleClockTest extends DeterministicLifecycleClockTest {
  scheduleCalls = 0;

  constructor(
    private readonly throwOnScheduleCall: number,
    private readonly thrownValue: unknown,
  ) {
    super();
  }

  override schedule(callback: () => void, delayMs: number) {
    this.scheduleCalls += 1;
    if (this.scheduleCalls === this.throwOnScheduleCall) throw this.thrownValue;
    return super.schedule(callback, delayMs);
  }
}

/** Fail selected close attempts without emitting close so terminal authority can be inspected. */
class ThrowingCloseSocketTest extends TestSocket {
  closeAttempts = 0;
  failClose = true;

  override close(code?: number, reason?: string) {
    this.closeAttempts += 1;
    this.lastClose = { code, reason };
    if (this.failClose) throw new Error("socket close exploded");
    this.emitClose(code, reason);
  }
}

function createRegistration(): SessionRegistration<TestSessionInfo> {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    info: { title: "repo working tree" },
  };
}

function createSnapshot(): SessionSnapshot<TestSessionState> {
  return {
    updatedAt: "2026-04-15T00:00:00.000Z",
    state: { selectedIndex: 0 },
  };
}

/** Create one valid producer authentication setup for lifecycle-only connection tests. */
async function createProducerAuthenticationTest() {
  const pair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const grant: ProducerGrant = {
    kind: "producer",
    appId: "dev.example",
    principalId: "producer-1",
    keyId: "producer-key-1",
    grantId: "producer-grant-1",
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revocationId: "producer-revocation-1",
    mayDelegate: false,
    operations: ["register"],
  };
  return {
    appId: "dev.example",
    appRevision: 1,
    credential: { grant, privateKey: pair.privateKey },
    daemon: { keyId: "daemon-key-1", publicKey: pair.publicKey },
  };
}

/** Await one lifecycle signal while turning a lost wakeup into a bounded test failure. */
async function settleWithinTestTimeout<T>(promise: PromiseLike<T> | T, timeoutMs = 500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Promise did not settle within ${timeoutMs}ms.`)),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Wait for one asynchronous socket send without leaving a lost wakeup unbounded. */
async function waitForSentMessagesTest(socket: TestSocket, count: number) {
  await settleWithinTestTimeout(
    (async () => {
      while (socket.sent.length < count) await Bun.sleep(0);
    })(),
  );
}

/** Create a manually released promise for reconnect race characterization. */
function createDeferredTest<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const protocolParsers = createSessionBrokerProtocolParsers<
  TestSessionInfo,
  TestSessionState,
  TestServerMessage,
  { ok: true }
>({
  appRevision: 1,
  features: [],
  parseRegistration: (value) =>
    value && typeof value === "object" ? (value as SessionRegistration<TestSessionInfo>) : null,
  parseSnapshot: (value) =>
    value && typeof value === "object" ? (value as SessionSnapshot<TestSessionState>) : null,
  commands: [
    {
      command: "annotate",
      version: 1,
      parseInput: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return Object.keys(record).length === 1 && typeof record.summary === "string"
          ? { summary: record.summary }
          : null;
      },
      parseResult: (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return Object.keys(record).length === 1 && record.ok === true ? { ok: true } : null;
      },
    },
  ],
});

describe("session broker connection", () => {
  test("times out and disposes authenticated producer handshakes deterministically", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const grant: ProducerGrant = {
      kind: "producer",
      appId: "dev.example",
      principalId: "producer-1",
      keyId: "producer-key-1",
      grantId: "producer-grant-1",
      algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      revocationId: "producer-revocation-1",
      mayDelegate: false,
      operations: ["register"],
    };
    const createConnectionTest = (clock: DeterministicLifecycleClockTest, socket: TestSocket) =>
      createSessionBrokerConnection({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        producerAuthentication: {
          appId: "dev.example",
          appRevision: 1,
          credential: { grant, privateKey: pair.privateKey },
          daemon: { keyId: "daemon-key-1", publicKey: pair.publicKey },
        },
        lifecycleClock: clock,
        resolveClose: () => ({ reconnect: false }),
      });

    const timeoutClock = new DeterministicLifecycleClockTest();
    const timeoutSocket = new TestSocket();
    const timedConnection = createConnectionTest(timeoutClock, timeoutSocket);
    timedConnection.start();
    expect(timeoutClock.pendingCountTest()).toBe(1);
    timeoutClock.advanceByTest(timedConnection.limits.maxHandshakeDurationMs - 1);
    expect(timeoutSocket.lastClose).toBeNull();
    timeoutClock.advanceByTest(1);
    expect(timeoutSocket.lastClose).toEqual({
      code: 1008,
      reason: "Session broker authentication timed out.",
    });
    expect(timeoutClock.pendingCountTest()).toBe(0);

    const disposalClock = new DeterministicLifecycleClockTest();
    const disposalSocket = new TestSocket();
    const disposedConnection = createConnectionTest(disposalClock, disposalSocket);
    disposedConnection.start();
    disposalSocket.emitClose();
    expect(disposalClock.pendingCountTest()).toBe(0);
    disposedConnection.stop();
    disposedConnection.stop();
    disposalClock.advanceByTest(disposedConnection.limits.maxHandshakeDurationMs);
    expect(disposalSocket.lastClose).toBeNull();
  });

  test("disposes an old heartbeat before reconnect and starts one replacement cadence", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const sockets: TestSocket[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });
    const heartbeatCountTest = (socket: TestSocket) =>
      socket.sent.filter((message) => JSON.parse(message).type === "heartbeat").length;

    connection.start();
    sockets[0]!.emitOpen();
    expect(clock.pendingCountTest()).toBe(1);
    sockets[0]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);

    clock.advanceByTest(10);
    expect(heartbeatCountTest(sockets[0]!)).toBe(0);
    clock.advanceByTest(20);
    await clock.flushMicrotasksTest();
    expect(sockets).toHaveLength(2);
    expect(clock.pendingCountTest()).toBe(0);

    sockets[1]!.emitOpen();
    expect(clock.pendingCountTest()).toBe(1);
    clock.advanceByTest(20);
    expect(heartbeatCountTest(sockets[0]!)).toBe(0);
    expect(heartbeatCountTest(sockets[1]!)).toBe(2);
    expect(clock.pendingCountTest()).toBe(1);

    connection.stop();
    expect(clock.pendingCountTest()).toBe(0);
  });

  test("contains a heartbeat defect once and terminally retires its timer", () => {
    const clock = new DeterministicLifecycleClockTest();
    const socket = new TestSocket();
    const defectMessages: string[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      heartbeatIntervalMs: 10,
      lifecycleClock: clock,
      onDefect: (message) => defectMessages.push(message),
    });

    connection.start();
    socket.emitOpen();
    socket.throwOnSend = true;

    expect(() => clock.advanceByTest(10)).not.toThrow();
    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    expect(clock.pendingCountTest()).toBe(0);
    expect(() => clock.advanceByTest(100)).not.toThrow();
    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    connection.start();
    expect(clock.pendingCountTest()).toBe(0);
  });

  test("observes async lifecycle callbacks and contains an async defect sink", async () => {
    const callbackMarker = `connected-${crypto.randomUUID()}`;
    const sinkMarker = `sink-${crypto.randomUUID()}`;
    const socket = new TestSocket();
    const defectMessages: string[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const connection = createSessionBrokerConnection({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        onConnected: async () => {
          throw new Error(callbackMarker);
        },
        onDefect: async (message) => {
          defectMessages.push(message);
          throw new Error(sinkMarker);
        },
      });

      connection.start();
      socket.emitOpen();
      await Bun.sleep(10);
      connection.start();

      expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
      expect(unhandledRejections).toEqual([]);
      expect(JSON.stringify({ defectMessages, sent: socket.sent })).not.toContain(callbackMarker);
      expect(JSON.stringify({ defectMessages, sent: socket.sent })).not.toContain(sinkMarker);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("contains a successful command-result transport defect without exposing it", async () => {
    const marker = `result-send-${crypto.randomUUID()}`;
    const socket = new TestSocket();
    const defectMessages: string[] = [];
    const capturedConsole: unknown[][] = [];
    const capturedStdout: unknown[][] = [];
    const capturedStderr: unknown[][] = [];
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    let factoryCalls = 0;
    let dispatches = 0;
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        factoryCalls += 1;
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: {
        dispatchCommand: async () => {
          dispatches += 1;
          return { ok: true };
        },
      },
      onDefect: (message) => defectMessages.push(message),
    });

    console.error = (...args: unknown[]) => capturedConsole.push(args);
    process.stdout.write = ((...args: unknown[]) => {
      capturedStdout.push(args);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((...args: unknown[]) => {
      capturedStderr.push(args);
      return true;
    }) as typeof process.stderr.write;
    try {
      connection.start();
      socket.emitOpen();
      socket.throwOnNextSend = new Error(marker);
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: "request-sensitive-send",
          command: "annotate",
          input: { summary: "review" },
        }),
      );
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: "request-queued-before-defect",
          command: "annotate",
          input: { summary: "must not dispatch" },
        }),
      );
      await Bun.sleep(0);

      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: "request-after-defect",
          command: "annotate",
          input: { summary: "ignored" },
        }),
      );
      connection.start();
      await Bun.sleep(0);
    } finally {
      console.error = originalConsoleError;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    expect({ dispatches, factoryCalls }).toEqual({ dispatches: 1, factoryCalls: 1 });
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    expect(capturedConsole).toEqual([]);
    expect(capturedStdout).toEqual([]);
    expect(capturedStderr).toEqual([]);
    expect(
      JSON.stringify({
        defectMessages,
        sent: socket.sent,
        close: socket.lastClose,
        registration: connection.getRegistration(),
        capturedConsole,
        capturedStdout,
        capturedStderr,
      }),
    ).not.toContain(marker);
  });

  test("contains an error command-result transport defect outside bridge rejection handling", async () => {
    const bridgeMarker = `bridge-error-${crypto.randomUUID()}`;
    const transportMarker = `error-send-${crypto.randomUUID()}`;
    const socket = new TestSocket();
    const defectMessages: string[] = [];
    let dispatches = 0;
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: {
        dispatchCommand: async () => {
          dispatches += 1;
          throw new Error(bridgeMarker);
        },
      },
      onDefect: (message) => defectMessages.push(message),
    });

    connection.start();
    socket.emitOpen();
    socket.throwOnNextSend = new Error(transportMarker);
    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-error-send",
        command: "annotate",
        input: { summary: "review" },
      }),
    );
    await Bun.sleep(0);

    expect(dispatches).toBe(1);
    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    const observable = JSON.stringify({
      defectMessages,
      sent: socket.sent,
      close: socket.lastClose,
      registration: connection.getRegistration(),
    });
    expect(observable).not.toContain(bridgeMarker);
    expect(observable).not.toContain(transportMarker);
  });

  test("contains direct authenticated handshake scheduling failure after socket commit", async () => {
    const marker = `direct-handshake-clock-${crypto.randomUUID()}`;
    const clock = new ThrowingScheduleClockTest(1, new Error(marker));
    const sockets: TestSocket[] = [];
    const defectMessages: string[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      producerAuthentication: await createProducerAuthenticationTest(),
      lifecycleClock: clock,
      onDefect: (message) => defectMessages.push(message),
    });

    expect(() => connection.start()).not.toThrow();
    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toMatchObject({
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      lastClose: { code: undefined, reason: undefined },
    });
    expect(clock.pendingCountTest()).toBe(0);
    connection.start();
    expect(sockets).toHaveLength(1);
    expect(JSON.stringify({ defectMessages, socket: sockets[0] })).not.toContain(marker);
  });

  test("contains authenticated handshake scheduling failure during natural reconnect", async () => {
    const marker = `reconnect-handshake-clock-${crypto.randomUUID()}`;
    const clock = new ThrowingScheduleClockTest(3, new Error(marker));
    const sockets: TestSocket[] = [];
    const defectMessages: string[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      producerAuthentication: await createProducerAuthenticationTest(),
      reconnectDelayMs: 10,
      lifecycleClock: clock,
      onDefect: (message) => defectMessages.push(message),
    });

    connection.start();
    sockets[0]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);
    await clock.advanceByTestAsync(10);

    expect(clock.scheduleCalls).toBe(3);
    expect(clock.pendingCountTest()).toBe(0);
    expect(defectMessages).toEqual([SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).toMatchObject({
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      lastClose: { code: undefined, reason: undefined },
    });
    connection.start();
    expect(sockets).toHaveLength(2);
    expect(JSON.stringify({ defectMessages, sockets })).not.toContain(marker);
  });

  test("redacts callback defects, contains its sink, and performs no package output", () => {
    const sinkMarker = `sink-${crypto.randomUUID()}`;
    const markers = Array.from({ length: 4 }, () => crypto.randomUUID());
    let getterReads = 0;
    let stringifications = 0;
    const thrownValues: unknown[] = [
      new Error(markers[0]),
      markers[1],
      { marker: markers[2] },
      {
        get marker() {
          getterReads += 1;
          return markers[3];
        },
        toString() {
          stringifications += 1;
          return markers[3];
        },
      },
    ];
    const hookArguments: unknown[][] = [];
    const capturedConsole: unknown[][] = [];
    const capturedStdout: unknown[][] = [];
    const capturedStderr: unknown[][] = [];
    const escaped: unknown[] = [];
    const registrations: string[] = [];
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    console.error = (...args: unknown[]) => capturedConsole.push(args);
    process.stdout.write = ((...args: unknown[]) => {
      capturedStdout.push(args);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((...args: unknown[]) => {
      capturedStderr.push(args);
      return true;
    }) as typeof process.stderr.write;
    try {
      for (const thrownValue of thrownValues) {
        const clock = new DeterministicLifecycleClockTest();
        const socket = new TestSocket();
        const connection = createSessionBrokerConnection({
          url: "ws://broker.test/session",
          createSocket: () => socket,
          registration: createRegistration(),
          snapshot: createSnapshot(),
          protocolParsers,
          reconnectDelayMs: 10,
          lifecycleClock: clock,
          resolveClose: () => {
            throw thrownValue;
          },
          onDefect: (...args) => {
            hookArguments.push(args);
            throw new Error(sinkMarker);
          },
        });

        connection.start();
        socket.emitOpen();
        try {
          socket.emitClose(1008, "close-policy");
        } catch (error) {
          escaped.push(error);
        }
        registrations.push(JSON.stringify(connection.getRegistration()));
        clock.advanceByTest(100);
        socket.emitClose(1008, "late-close");
        connection.start();

        expect(clock.pendingCountTest()).toBe(0);
      }
    } finally {
      console.error = originalConsoleError;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(hookArguments).toEqual(
      thrownValues.map(() => [SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE]),
    );
    expect(capturedConsole).toEqual([]);
    expect(capturedStdout).toEqual([]);
    expect(capturedStderr).toEqual([]);
    expect(escaped).toEqual([]);
    expect(getterReads).toBe(0);
    expect(stringifications).toBe(0);
    const observableText = JSON.stringify({
      hookArguments,
      capturedConsole,
      capturedStdout,
      capturedStderr,
      escaped,
      registrations,
    });
    for (const marker of [...markers, sinkMarker]) expect(observableText).not.toContain(marker);
  });

  test("uses a delayed fixed-rate heartbeat and disposes it on stop", () => {
    const clock = new DeterministicLifecycleClockTest();
    const socket = new TestSocket();
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      heartbeatIntervalMs: 10,
      lifecycleClock: clock,
    });

    connection.start();
    socket.emitOpen();
    const heartbeatCountTest = () =>
      socket.sent.filter((message) => JSON.parse(message).type === "heartbeat").length;
    expect(heartbeatCountTest()).toBe(0);
    expect(clock.pendingCountTest()).toBe(1);

    clock.advanceByTest(9);
    expect(heartbeatCountTest()).toBe(0);
    clock.advanceByTest(1);
    expect(heartbeatCountTest()).toBe(1);
    clock.advanceByTest(20);
    expect(heartbeatCountTest()).toBe(3);

    connection.stop();
    connection.stop();
    expect(clock.pendingCountTest()).toBe(0);
    clock.advanceByTest(20);
    expect(heartbeatCountTest()).toBe(3);
  });

  test("uses and disposes the injected reconnect delay", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const sockets: TestSocket[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });

    connection.start();
    sockets[0]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);
    clock.advanceByTest(29);
    expect(sockets).toHaveLength(1);
    clock.advanceByTest(1);
    await clock.flushMicrotasksTest();
    expect(sockets).toHaveLength(2);

    sockets[1]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);
    connection.stop();
    connection.stop();
    expect(clock.pendingCountTest()).toBe(0);
    clock.advanceByTest(30);
    expect(sockets).toHaveLength(2);
  });

  test("replaces a stale generation retry timer with the current generation deadline", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const sockets: TestSocket[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 30,
      lifecycleClock: clock,
    });

    connection.start();
    sockets[0]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);

    connection.start();
    expect(sockets).toHaveLength(2);
    expect(clock.pendingCountTest()).toBe(0);
    sockets[1]!.emitClose();
    expect(clock.pendingCountTest()).toBe(1);

    clock.advanceByTest(29);
    expect(sockets).toHaveLength(2);
    clock.advanceByTest(1);
    await clock.flushMicrotasksTest();
    expect(sockets).toHaveLength(3);
    connection.stop();
  });

  test("registers on open and sends later snapshot updates", () => {
    const sockets: TestSocket[] = [];
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });

    connection.start();
    sockets[0]?.emitOpen();

    const registerMessage = JSON.parse(sockets[0]!.sent[0]!) as {
      type: string;
    };
    expect(registerMessage.type).toBe("register");

    connection.updateSnapshot({
      updatedAt: "2026-04-15T00:00:01.000Z",
      state: { selectedIndex: 1 },
    });

    const snapshotMessage = JSON.parse(sockets[0]!.sent[1]!) as {
      type: string;
      snapshot: unknown;
    };
    expect(snapshotMessage.type).toBe("snapshot");
    expect(snapshotMessage.snapshot).toEqual({
      updatedAt: "2026-04-15T00:00:01.000Z",
      state: { selectedIndex: 1 },
    });
  });

  test("preserves a synchronous socket factory throw and permits a later direct start", () => {
    const sockets: TestSocket[] = [];
    const startupFailure = { source: "socket factory" };
    const defectMessages: string[] = [];
    let attempts = 0;
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        attempts += 1;
        if (attempts === 1) throw startupFailure;
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      onDefect: (message) => defectMessages.push(message),
    });

    let thrown: unknown;
    try {
      connection.start();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(startupFailure);
    expect(attempts).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(defectMessages).toEqual([]);

    connection.start();
    sockets[0]!.emitOpen();
    expect(attempts).toBe(2);
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: "register",
    });
    connection.stop();
  });

  test("publishes socket construction ownership before a reentrant start", () => {
    const socket = new TestSocket();
    let attempts = 0;
    let connection!: TestConnection;
    connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        attempts += 1;
        connection.start();
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });

    connection.start();
    socket.emitOpen();
    expect(attempts).toBe(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "register" });
    connection.stop();
  });

  test("does not adopt a socket returned after reentrant terminal stop", () => {
    const socket = new TestSocket();
    let attempts = 0;
    let connection!: TestConnection;
    connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        attempts += 1;
        connection.stop();
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });

    connection.start();
    socket.emitOpen();
    connection.start();
    expect(attempts).toBe(1);
    expect(socket.lastClose).toEqual({ code: undefined, reason: undefined });
    expect(socket.sent).toEqual([]);
  });

  test("rejects a socket object reused across generations", () => {
    const socket = new TestSocket();
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      resolveClose: () => ({ reconnect: false }),
    });

    connection.start();
    socket.emitOpen();
    socket.emitClose();
    expect(() => connection.start()).toThrow(
      "Session broker socket factory must return a fresh socket.",
    );
    connection.stop();
  });

  test("retries close after an adapter throw while terminal stop remains authoritative", () => {
    const socket = new TestSocket();
    let closeAttempts = 0;
    socket.close = () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("socket close exploded");
      socket.emitClose();
    };
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });

    connection.start();
    socket.emitOpen();
    expect(() => connection.stop()).toThrow("socket close exploded");
    expect(() => connection.stop()).not.toThrow();
    expect(closeAttempts).toBe(2);
  });

  test("keeps malformed-input close failures terminal before a later close retry", () => {
    const socket = new ThrowingCloseSocketTest();
    let dispatches = 0;
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: {
        dispatchCommand: async () => {
          dispatches += 1;
          return { ok: true } as const;
        },
      },
      resolveClose: () => ({ reconnect: false }),
    });

    connection.start();
    socket.emitOpen();
    expect(() => socket.emitMessage("{")).not.toThrow();
    expect(socket.closeAttempts).toBe(2);
    const sentBeforeLateCommand = socket.sent.length;

    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-late",
        command: "annotate",
        input: { summary: "must stay retired" },
      }),
    );
    expect(dispatches).toBe(0);
    expect(socket.sent).toHaveLength(sentBeforeLateCommand);
    expect(socket.closeAttempts).toBe(2);

    socket.failClose = false;
    socket.onerror?.();
    expect(socket.closeAttempts).toBe(2);
    connection.stop();
  });

  test("keeps a failed handshake-timeout close terminal before late authentication", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const socket = new ThrowingCloseSocketTest();
    const pair = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const grant: ProducerGrant = {
      kind: "producer",
      appId: "dev.example",
      principalId: "producer-1",
      keyId: "producer-key-1",
      grantId: "producer-grant-1",
      algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      revocationId: "producer-revocation-1",
      mayDelegate: false,
      operations: ["register"],
    };
    const authenticator = new SessionBrokerAuthenticator({
      appId: "dev.example",
      appRevision: 1,
      generation: "generation-1",
      daemonIdentity: { keyId: "daemon-key-1", privateKey: pair.privateKey },
      credentials: [{ grant, publicKey: pair.publicKey }],
    });
    let connected = 0;
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      producerAuthentication: {
        appId: "dev.example",
        appRevision: 1,
        credential: { grant, privateKey: pair.privateKey },
        daemon: { keyId: "daemon-key-1", publicKey: pair.publicKey },
      },
      lifecycleClock: clock,
      onConnected: () => {
        connected += 1;
      },
      resolveClose: () => ({ reconnect: false }),
    });

    connection.start();
    socket.emitOpen();
    const helloInit = JSON.parse(socket.sent[0]!) as { hello: unknown };
    const challenge = await authenticator.issueChallenge(
      helloInit.hello,
      "ws://broker.test/session",
    );
    expect(() => clock.advanceByTest(connection.limits.maxHandshakeDurationMs)).not.toThrow();
    expect(socket.closeAttempts).toBe(2);

    socket.emitMessage(JSON.stringify({ type: "hello-challenge", challenge }));
    await clock.flushMicrotasksTest();
    expect(socket.sent).toHaveLength(1);
    expect(connected).toBe(0);

    socket.failClose = false;
    socket.onerror?.();
    expect(socket.closeAttempts).toBe(2);
    connection.stop();
  });

  test("passes callbacks an immutable opaque generation token", () => {
    const sockets: TestSocket[] = [];
    const callbackTokens: unknown[] = [];
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      resolveClose: (_event, generation) => {
        callbackTokens.push(generation);
        return { reconnect: false };
      },
      onConnected: (generation) => callbackTokens.push(generation),
    });

    connection.start();
    sockets[0]!.emitOpen();
    const token = callbackTokens[0] as { id: number };
    expect(Object.keys(token)).toEqual(["id"]);
    expect(Object.isFrozen(token)).toBe(true);
    expect(connection.isGenerationCurrent(token)).toBe(true);
    expect(connection.isGenerationCurrent({ id: token.id })).toBe(false);
    expect(() => Object.assign(token, { status: "closed" })).toThrow();

    sockets[0]!.emitClose();
    expect(callbackTokens[1]).toBe(token);
    connection.start();
    sockets[1]!.emitOpen();
    expect(connection.isGenerationCurrent(token)).toBe(false);
    connection.stop();
  });

  test("withholds registration until signed authentication disposes its handshake timer", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const socket = new TestSocket();
    const pair = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const grant: ProducerGrant = {
      kind: "producer",
      appId: "dev.example",
      principalId: "producer-1",
      keyId: "producer-key-1",
      grantId: "producer-grant-1",
      algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      revocationId: "producer-revocation-1",
      mayDelegate: false,
      operations: ["register", "reconnect"],
    };
    const authenticator = new SessionBrokerAuthenticator({
      appId: "dev.example",
      appRevision: 1,
      generation: "generation-1",
      daemonIdentity: { keyId: "daemon-key-1", privateKey: pair.privateKey },
      credentials: [{ grant, publicKey: pair.publicKey }],
    });
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      producerAuthentication: {
        appId: "dev.example",
        appRevision: 1,
        credential: { grant, privateKey: pair.privateKey },
        daemon: { keyId: "daemon-key-1", publicKey: pair.publicKey },
      },
      heartbeatIntervalMs: 60_000,
      lifecycleClock: clock,
    });

    connection.start();
    expect(clock.pendingCountTest()).toBe(1);
    socket.emitOpen();
    connection.updateSnapshot({
      ...createSnapshot(),
      state: { selectedIndex: 2 },
    });
    connection.replaceSession(createRegistration(), createSnapshot());

    expect(socket.sent).toHaveLength(1);
    const helloInit = JSON.parse(socket.sent[0]!) as {
      type: string;
      hello: unknown;
    };
    expect(helloInit.type).toBe("hello-init");
    const challenge = await authenticator.issueChallenge(
      helloInit.hello,
      "ws://broker.test/session",
    );
    socket.emitMessage(JSON.stringify({ type: "hello-challenge", challenge }));
    await waitForSentMessagesTest(socket, 2);
    const helloProof = JSON.parse(socket.sent[1]!) as {
      type: string;
      proof: unknown;
    };
    expect(helloProof.type).toBe("hello-proof");
    const authenticated = await authenticator.completeProducerHello(
      helloProof.proof,
      "connection-1",
    );
    socket.emitMessage(JSON.stringify({ type: "hello-ack", ack: authenticated.ack }));
    await waitForSentMessagesTest(socket, 3);

    expect(JSON.parse(socket.sent[2]!)).toMatchObject({ type: "register" });
    expect(clock.pendingCountTest()).toBe(1);
    clock.advanceByTest(connection.limits.maxHandshakeDurationMs);
    expect(socket.lastClose).toBeNull();
    expect(clock.pendingCountTest()).toBe(1);

    connection.stop();
    expect(clock.pendingCountTest()).toBe(0);
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`does not activate a late acknowledgement ${outcome} after the handshake deadline`, async () => {
      const clock = new DeterministicLifecycleClockTest();
      const socket = new DeferredCloseSocketTest();
      const pair = (await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const grant: ProducerGrant = {
        kind: "producer",
        appId: "dev.example",
        principalId: "producer-1",
        keyId: "producer-key-1",
        grantId: "producer-grant-1",
        algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
        issuedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
        revocationId: "producer-revocation-1",
        mayDelegate: false,
        operations: ["register"],
      };
      const authenticator = new SessionBrokerAuthenticator({
        appId: "dev.example",
        appRevision: 1,
        generation: "generation-1",
        daemonIdentity: { keyId: "daemon-key-1", privateKey: pair.privateKey },
        credentials: [{ grant, publicKey: pair.publicKey }],
      });
      const ackVerification = createDeferredTest<boolean>();
      const ackVerificationStarted = createDeferredTest();
      let verifyCalls = 0;
      const connection = createSessionBrokerConnection({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        producerAuthentication: {
          appId: "dev.example",
          appRevision: 1,
          credential: { grant, privateKey: pair.privateKey },
          daemon: { keyId: "daemon-key-1", publicKey: pair.publicKey },
          crypto: {
            ...webSessionBrokerCrypto,
            verify: async (...args) => {
              verifyCalls += 1;
              if (verifyCalls === 2) {
                ackVerificationStarted.resolve();
                return ackVerification.promise;
              }
              return webSessionBrokerCrypto.verify(...args);
            },
          },
        },
        heartbeatIntervalMs: 10,
        lifecycleClock: clock,
      });

      connection.start();
      socket.emitOpen();
      const helloInit = JSON.parse(socket.sent[0]!) as { hello: unknown };
      const challenge = await authenticator.issueChallenge(
        helloInit.hello,
        "ws://broker.test/session",
      );
      socket.emitMessage(JSON.stringify({ type: "hello-challenge", challenge }));
      await waitForSentMessagesTest(socket, 2);
      const helloProof = JSON.parse(socket.sent[1]!) as { proof: unknown };
      const authenticated = await authenticator.completeProducerHello(
        helloProof.proof,
        "connection-1",
      );
      socket.emitMessage(JSON.stringify({ type: "hello-ack", ack: authenticated.ack }));
      await settleWithinTestTimeout(ackVerificationStarted.promise);

      clock.advanceByTest(connection.limits.maxHandshakeDurationMs);
      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Session broker authentication timed out.",
      });
      if (outcome === "resolve") ackVerification.resolve(true);
      else ackVerification.reject(new Error("late acknowledgement verification failure"));
      await clock.flushMicrotasksTest();
      clock.advanceByTest(20);
      expect(socket.sent).toHaveLength(2);
      expect(clock.pendingCountTest()).toBe(0);

      socket.emitClose(1008, "Session broker authentication timed out.");
      connection.stop();
    });
  }

  test("publishes a pending replacement through a generation rotated during serialization", () => {
    const sockets: TestSocket[] = [];
    const registration = createRegistration();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration,
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 10_000,
    });
    connection.start();
    sockets[0]!.emitOpen();

    let rotated = false;
    const replacement = {
      ...registration,
      sessionId: "session-2",
      info: {
        title: "replacement",
        toJSON() {
          if (!rotated) {
            rotated = true;
            sockets[0]!.emitClose();
            connection.start();
            sockets[1]!.emitOpen();
          }
          return { title: "replacement" };
        },
      },
    };
    const replacementSnapshot = {
      ...createSnapshot(),
      state: { selectedIndex: 2 },
    };

    connection.replaceSession(replacement, replacementSnapshot);

    expect(connection.getRegistration()).toBe(replacement);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: "register",
      registration: {
        ...replacement,
        info: { title: "replacement" },
      },
      snapshot: replacementSnapshot,
    });
    connection.stop();
  });

  test("commits a candidate published by a replacement before the stale source send throws", () => {
    const sockets: TestSocket[] = [];
    const registration = createRegistration();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration,
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 10_000,
    });
    connection.start();
    sockets[0]!.emitOpen();

    const firstSend = sockets[0]!.send.bind(sockets[0]);
    sockets[0]!.send = (data) => {
      const message = JSON.parse(data) as { registration?: { sessionId?: string } };
      if (message.registration?.sessionId === "session-2") {
        sockets[0]!.emitClose();
        connection.start();
        sockets[1]!.emitOpen();
        throw new Error("stale source exploded");
      }
      firstSend(data);
    };
    const replacement = { ...registration, sessionId: "session-2" };
    const replacementSnapshot = {
      ...createSnapshot(),
      state: { selectedIndex: 2 },
    };

    connection.replaceSession(replacement, replacementSnapshot);

    expect(connection.getRegistration()).toBe(replacement);
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: "register",
      registration: replacement,
      snapshot: replacementSnapshot,
    });
    connection.stop();
  });

  test("keeps the previous registration and snapshot when the current generation send throws", () => {
    const sockets: TestSocket[] = [];
    const registration = createRegistration();
    const snapshot = createSnapshot();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration,
      snapshot,
      protocolParsers,
      reconnectDelayMs: 10_000,
    });
    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.throwOnSend = true;

    expect(() =>
      connection.replaceSession(
        { ...registration, sessionId: "session-2" },
        { ...snapshot, state: { selectedIndex: 2 } },
      ),
    ).toThrow("socket exploded");
    expect(connection.getRegistration()).toBe(registration);

    sockets[0]!.throwOnSend = false;
    sockets[0]!.emitClose();
    connection.start();
    sockets[1]!.emitOpen();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: "register",
      registration,
      snapshot,
    });
    connection.stop();
  });

  test("queues broker commands until the app bridge is ready", async () => {
    const socket = new TestSocket();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });

    connection.start();
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-1",
        command: "annotate",
        input: { summary: "Review note" },
      }),
    );

    connection.setBridge({
      dispatchCommand: async () => ({ ok: true }),
    });

    await Bun.sleep(0);
    const resultMessage = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
      ok: boolean;
    };
    expect(resultMessage).toMatchObject({ type: "command-result", ok: true });
  });

  test("parses and transforms each server command once before bridge dispatch", async () => {
    let inputCalls = 0;
    let resultCalls = 0;
    const transformingParsers = createSessionBrokerProtocolParsers<
      TestSessionInfo,
      TestSessionState,
      TestServerMessage,
      { ok: true }
    >({
      appRevision: 1,
      features: [],
      parseRegistration: protocolParsers.parseRegistration.bind(protocolParsers),
      parseSnapshot: protocolParsers.parseSnapshot.bind(protocolParsers),
      commands: [
        {
          command: "annotate",
          version: 1,
          parseInput: (value) => {
            inputCalls += 1;
            const summary = (value as { summary?: unknown })?.summary;
            return typeof summary === "string" ? { summary: summary.toUpperCase() } : null;
          },
          parseResult: (value) => {
            resultCalls += 1;
            return (value as { ok?: unknown })?.ok === true ? { ok: true } : null;
          },
        },
      ],
    });
    const socket = new TestSocket();
    let bridgedInput: unknown;
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: transformingParsers,
      bridge: {
        dispatchCommand: async (message) => {
          bridgedInput = message.input;
          return { ok: true };
        },
      },
    });

    connection.start();
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-1",
        command: "annotate",
        input: { summary: "review note" },
      }),
    );
    await Bun.sleep(0);

    expect(bridgedInput).toEqual({ summary: "REVIEW NOTE" });
    expect({ inputCalls, resultCalls }).toEqual({
      inputCalls: 1,
      resultCalls: 1,
    });
    connection.stop();
  });

  test("closes malformed and mismatched commands without invoking the bridge", async () => {
    let dispatched = 0;
    const defectMessages: string[] = [];

    for (const message of [
      null,
      [],
      {
        type: "command",
        requestId: "request-1",
        command: "unknown",
        input: {},
      },
      {
        type: "command",
        requestId: "request-1",
        command: "annotate",
        input: { summary: "note", extra: true },
      },
    ]) {
      const socket = new TestSocket();
      const connection = createSessionBrokerConnection<
        TestSessionInfo,
        TestSessionState,
        TestSocket,
        TestServerMessage,
        { ok: true }
      >({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        bridge: {
          dispatchCommand: async () => {
            dispatched += 1;
            return { ok: true };
          },
        },
        reconnectDelayMs: 1_000,
        onDefect: (defect) => defectMessages.push(defect),
      });
      connection.start();
      socket.emitOpen();
      socket.emitMessage(JSON.stringify(message));
      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Malformed session broker command.",
      });
      expect(defectMessages).toEqual([]);
      connection.stop();
    }
    await Bun.sleep(0);
    expect(dispatched).toBe(0);
    expect(defectMessages).toEqual([]);
  });

  test("enforces text framing and the exact websocket message ceiling before app parsing", async () => {
    const maxBytes = 512;
    let inputCalls = 0;
    let bridgeCalls = 0;
    const boundedParsers = createSessionBrokerProtocolParsers<
      TestSessionInfo,
      TestSessionState,
      TestServerMessage,
      { ok: true }
    >({
      appRevision: 1,
      features: [],
      parseRegistration: (value) => value as SessionRegistration<TestSessionInfo>,
      parseSnapshot: (value) => value as SessionSnapshot<TestSessionState>,
      commands: [
        {
          command: "annotate",
          version: 1,
          parseInput: (value) => {
            inputCalls += 1;
            return value as { summary: string };
          },
          parseResult: () => ({ ok: true }),
        },
      ],
    });
    const socket = new TestSocket();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: boundedParsers,
      bridge: {
        dispatchCommand: async () => {
          bridgeCalls += 1;
          return { ok: true };
        },
      },
      limits: { maxWsMessageBytes: maxBytes },
      reconnectDelayMs: 10_000,
    });
    connection.start();
    socket.emitOpen();

    const prefix = JSON.stringify({
      type: "command",
      requestId: "request-exact",
      command: "annotate",
      input: { summary: "" },
    });
    const emptySummaryBytes = new TextEncoder().encode(prefix).byteLength;
    const exact = JSON.stringify({
      type: "command",
      requestId: "request-exact",
      command: "annotate",
      input: { summary: "x".repeat(maxBytes - emptySummaryBytes) },
    });
    expect(new TextEncoder().encode(exact).byteLength).toBe(maxBytes);
    socket.emitMessage(exact);
    await Bun.sleep(0);
    expect({ inputCalls, bridgeCalls }).toEqual({
      inputCalls: 1,
      bridgeCalls: 1,
    });

    connection.stop();

    const emitRejected = (data: unknown) => {
      const rejectedSocket = new TestSocket();
      const rejectedConnection = createSessionBrokerConnection<
        TestSessionInfo,
        TestSessionState,
        TestSocket,
        TestServerMessage,
        { ok: true }
      >({
        url: "ws://broker.test/session",
        createSocket: () => rejectedSocket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers: boundedParsers,
        bridge: {
          dispatchCommand: async () => {
            bridgeCalls += 1;
            return { ok: true };
          },
        },
        limits: { maxWsMessageBytes: maxBytes },
        reconnectDelayMs: 10_000,
      });
      rejectedConnection.start();
      rejectedSocket.emitOpen();
      rejectedSocket.emitMessage(data);
      const close = rejectedSocket.lastClose;
      rejectedConnection.stop();
      return close;
    };

    expect(emitRejected(`${exact} `)).toMatchObject({ code: 1009 });
    expect(emitRejected("{".repeat(maxBytes + 1))).toMatchObject({
      code: 1009,
    });
    expect(
      emitRejected(
        JSON.stringify({
          type: "command",
          requestId: "request-extra",
          command: "annotate",
          input: { summary: "not parsed" },
          extra: true,
        }),
      ),
    ).toMatchObject({ code: 1008 });
    expect(emitRejected(new Uint8Array([123, 125]))).toMatchObject({
      code: 1003,
    });
    expect({ inputCalls, bridgeCalls }).toEqual({
      inputCalls: 1,
      bridgeCalls: 1,
    });
  });

  test("ignores a late socket callback after stop before parsing or reserving", async () => {
    let inputCalls = 0;
    let bridgeCalls = 0;
    const lateParsers = createSessionBrokerProtocolParsers<
      TestSessionInfo,
      TestSessionState,
      TestServerMessage,
      { ok: true }
    >({
      appRevision: 1,
      features: [],
      parseRegistration: (value) => value as SessionRegistration<TestSessionInfo>,
      parseSnapshot: (value) => value as SessionSnapshot<TestSessionState>,
      commands: [
        {
          command: "annotate",
          version: 1,
          parseInput: (value) => {
            inputCalls += 1;
            return value as { summary: string };
          },
          parseResult: () => ({ ok: true }),
        },
      ],
    });
    const socket = new TestSocket();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: lateParsers,
      bridge: {
        dispatchCommand: async () => {
          bridgeCalls += 1;
          return { ok: true };
        },
      },
      limits: { maxPreBridgeCommands: 1 },
    });
    connection.start();
    socket.emitOpen();
    connection.stop();
    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-late",
        command: "annotate",
        input: { summary: "late" },
      }),
    );
    await Bun.sleep(0);

    expect({ inputCalls, bridgeCalls }).toEqual({
      inputCalls: 0,
      bridgeCalls: 0,
    });
  });

  test("does not migrate a late command result onto a replacement socket", async () => {
    const sockets: TestSocket[] = [];
    let resolveCommand!: (result: { ok: true }) => void;
    const commandResult = new Promise<{ ok: true }>((resolve) => {
      resolveCommand = resolve;
    });
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: { dispatchCommand: () => commandResult },
      reconnectDelayMs: 1,
    });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-1",
        command: "annotate",
        input: { summary: "Review note" },
      }),
    );
    sockets[0]!.emitClose();
    await Bun.sleep(5);
    sockets[1]!.emitOpen();

    resolveCommand({ ok: true });
    await Bun.sleep(0);

    expect(sockets[0]!.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    expect(sockets[1]!.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    connection.stop();
  });

  test("closes post-dispatch result failures without defect reporting or sensitive output", async () => {
    type AdversarialResult = { ok: true; toJSON?: () => { ok: true } };

    for (const failure of ["measurement", "parser", "serialization"] as const) {
      const marker = `${failure}-${crypto.randomUUID()}`;
      let parsedSerializationCalls = 0;
      const bridgeResult: AdversarialResult =
        failure === "measurement"
          ? {
              ok: true,
              toJSON: () => {
                throw new Error(marker);
              },
            }
          : { ok: true };
      const parsedResult: AdversarialResult =
        failure === "serialization"
          ? {
              ok: true,
              toJSON: () => {
                parsedSerializationCalls += 1;
                if (parsedSerializationCalls === 2) throw new Error(marker);
                return { ok: true };
              },
            }
          : { ok: true };
      const adversarialParsers = createSessionBrokerProtocolParsers<
        TestSessionInfo,
        TestSessionState,
        TestServerMessage,
        AdversarialResult
      >({
        appRevision: 1,
        features: [],
        parseRegistration: (value) => value as SessionRegistration<TestSessionInfo>,
        parseSnapshot: (value) => value as SessionSnapshot<TestSessionState>,
        commands: [
          {
            command: "annotate",
            version: 1,
            parseInput: (value) => value as { summary: string },
            parseResult: () => {
              if (failure === "parser") throw new Error(marker);
              return parsedResult;
            },
          },
        ],
      });
      const socket = new TestSocket();
      const defectMessages: string[] = [];
      const connection = createSessionBrokerConnection<
        TestSessionInfo,
        TestSessionState,
        TestSocket,
        TestServerMessage,
        AdversarialResult
      >({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers: adversarialParsers,
        bridge: { dispatchCommand: async () => bridgeResult },
        onDefect: (message) => defectMessages.push(message),
      });

      connection.start();
      socket.emitOpen();
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: `request-${failure}`,
          command: "annotate",
          input: { summary: "review" },
        }),
      );
      await Bun.sleep(0);

      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Malformed session broker command result.",
      });
      expect(defectMessages).toEqual([]);
      expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
      expect(
        JSON.stringify({ defectMessages, sent: socket.sent, close: socket.lastClose }),
      ).not.toContain(marker);
      connection.stop();
    }
  });

  test("does not send a command result when envelope serialization retires its generation", async () => {
    type ReentrantResult = { ok: true; toJSON: () => { ok: true } };
    const socket = new TestSocket();
    let serializationCount = 0;
    const result: ReentrantResult = {
      ok: true,
      toJSON: () => {
        serializationCount += 1;
        if (serializationCount === 3) socket.emitClose(1000, "serialization retired");
        return { ok: true };
      },
    };
    const reentrantParsers = createSessionBrokerProtocolParsers<
      TestSessionInfo,
      TestSessionState,
      TestServerMessage,
      ReentrantResult
    >({
      appRevision: 1,
      features: [],
      parseRegistration: (value) => value as SessionRegistration<TestSessionInfo>,
      parseSnapshot: (value) => value as SessionSnapshot<TestSessionState>,
      commands: [
        {
          command: "annotate",
          version: 1,
          parseInput: (value) => value as { summary: string },
          parseResult: (value) => value as ReentrantResult,
        },
      ],
    });
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      ReentrantResult
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: reentrantParsers,
      bridge: { dispatchCommand: async () => result },
      reconnectDelayMs: 10_000,
    });

    connection.start();
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-serialization",
        command: "annotate",
        input: { summary: "Retire during result serialization" },
      }),
    );
    await Bun.sleep(0);

    expect(serializationCount).toBe(3);
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    connection.stop();
  });

  test("discards queued commands when their source socket disconnects", async () => {
    const sockets: TestSocket[] = [];
    const dispatched: string[] = [];
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 1,
    });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-old",
        command: "annotate",
        input: { summary: "Old review note" },
      }),
    );
    sockets[0]!.emitClose();
    await Bun.sleep(5);
    sockets[1]!.emitOpen();

    connection.setBridge({
      dispatchCommand: async (message) => {
        dispatched.push(message.requestId);
        return { ok: true };
      },
    });
    await Bun.sleep(0);

    expect(dispatched).toEqual([]);
    expect(sockets[1]!.sent.map((message) => JSON.parse(message).type)).toEqual(["register"]);
    connection.stop();
  });

  test("stops replaying a queued batch when its source socket disconnects", async () => {
    const socket = new TestSocket();
    const dispatched: string[] = [];
    let resolveFirst!: (result: { ok: true }) => void;
    const firstResult = new Promise<{ ok: true }>((resolve) => {
      resolveFirst = resolve;
    });
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 1_000,
    });

    connection.start();
    socket.emitOpen();
    for (const requestId of ["request-1", "request-2"]) {
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId,
          command: "annotate",
          input: { summary: "Review note" },
        }),
      );
    }

    connection.setBridge({
      dispatchCommand: (message) => {
        dispatched.push(message.requestId);
        return message.requestId === "request-1"
          ? firstResult
          : Promise.resolve({ ok: true as const });
      },
    });
    await Bun.sleep(0);
    socket.emitClose();
    resolveFirst({ ok: true });
    await Bun.sleep(0);

    expect(dispatched).toEqual(["request-1"]);
    connection.stop();
  });

  test("refuses queue admission when an app parser replaces the active generation", () => {
    const sockets: TestSocket[] = [];
    let replaceDuringParse = true;
    let connection!: TestConnection;
    const reentrantParsers = Object.assign(Object.create(protocolParsers), {
      parseServerMessage(value: unknown) {
        const parsed = protocolParsers.parseServerMessage(value);
        if (replaceDuringParse) {
          replaceDuringParse = false;
          sockets[0]!.emitClose();
          connection.start();
          sockets[1]!.emitOpen();
        }
        return parsed;
      },
    }) as typeof protocolParsers;
    connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: reentrantParsers,
      limits: { maxPreBridgeCommands: 1 },
    });
    const command = (requestId: string) =>
      JSON.stringify({
        type: "command",
        requestId,
        command: "annotate",
        input: { summary: requestId },
      });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(command("request-stale"));
    sockets[1]!.emitMessage(command("request-current"));
    expect(
      sockets[1]!.sent.filter((message) => JSON.parse(message).type === "command-result"),
    ).toEqual([]);

    sockets[1]!.emitMessage(command("request-over-capacity"));
    expect(JSON.parse(sockets[1]!.sent.at(-1)!)).toMatchObject({
      requestId: "request-over-capacity",
      error: "queue-full",
    });
    connection.stop();
  });

  test("refuses stale admission when command serialization replaces the generation", async () => {
    const sockets: TestSocket[] = [];
    const dispatched: string[] = [];
    let parserCalls = 0;
    let serializationCalls = 0;
    let replaceDuringSerialization = true;
    let connection!: TestConnection;
    const reentrantParsers = Object.assign(Object.create(protocolParsers), {
      parseServerMessage(value: unknown) {
        parserCalls += 1;
        const parsed = protocolParsers.parseServerMessage(value);
        const type = parsed.type;
        Object.defineProperty(parsed, "type", {
          configurable: true,
          enumerable: true,
          get: () => {
            serializationCalls += 1;
            if (replaceDuringSerialization) {
              replaceDuringSerialization = false;
              sockets[0]!.emitClose();
              connection.start();
              sockets[1]!.emitOpen();
            }
            return type;
          },
        });
        return parsed;
      },
    }) as typeof protocolParsers;
    connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers: reentrantParsers,
      limits: { maxPreBridgeCommands: 1 },
    });
    const command = (requestId: string) =>
      JSON.stringify({
        type: "command",
        requestId,
        command: "annotate",
        input: { summary: requestId },
      });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(command("request-stale"));
    await Bun.sleep(0);
    expect(parserCalls).toBe(1);
    expect(serializationCalls).toBe(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.emitMessage(command("request-current"));
    expect(
      sockets[1]!.sent.filter((message) => JSON.parse(message).type === "command-result"),
    ).toEqual([]);

    connection.setBridge({
      dispatchCommand: async (message) => {
        dispatched.push(message.requestId);
        return { ok: true };
      },
    });
    await waitForSentMessagesTest(sockets[1]!, 2);
    expect(dispatched).toEqual(["request-current"]);
    expect(JSON.parse(sockets[1]!.sent.at(-1)!)).toMatchObject({
      type: "command-result",
      requestId: "request-current",
      ok: true,
    });
    connection.stop();
  });

  test("keeps 32 missing-bridge commands FIFO and explicitly rejects the 33rd", async () => {
    const socket = new TestSocket();
    const dispatched: string[] = [];
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
    });
    connection.start();
    socket.emitOpen();
    for (let index = 1; index <= 33; index += 1) {
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: `request-${index}`,
          command: "annotate",
          input: { summary: `note-${index}` },
        }),
      );
    }
    const overflow = JSON.parse(socket.sent.at(-1)!) as {
      requestId: string;
      error: string;
    };
    expect(overflow).toMatchObject({
      requestId: "request-33",
      error: "queue-full",
    });

    connection.setBridge({
      dispatchCommand: async (message) => {
        dispatched.push(message.requestId);
        return { ok: true };
      },
    });
    await Bun.sleep(10);
    expect(dispatched).toEqual(Array.from({ length: 32 }, (_, index) => `request-${index + 1}`));
    connection.stop();
  });

  test("keeps a hung bridge plus queued commands within the same 32-command budget", async () => {
    const socket = new TestSocket();
    const never = new Promise<{ ok: true }>(() => {});
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: { dispatchCommand: () => never },
    });
    connection.start();
    socket.emitOpen();
    for (let index = 1; index <= 33; index += 1) {
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId: `request-${index}`,
          command: "annotate",
          input: { summary: `note-${index}` },
        }),
      );
    }
    await Bun.sleep(0);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      requestId: "request-33",
      error: "queue-full",
    });
    connection.stop();
  });

  test("retains a hung command reservation across disconnect and reconnect", async () => {
    const sockets: TestSocket[] = [];
    const never = new Promise<{ ok: true }>(() => {});
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: { dispatchCommand: () => never },
      reconnectDelayMs: 1,
      limits: { maxPreBridgeCommands: 1 },
    });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-hung",
        command: "annotate",
        input: { summary: "hung" },
      }),
    );
    await Bun.sleep(0);
    sockets[0]!.emitClose();
    await Bun.sleep(5);
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage(
      JSON.stringify({
        type: "command",
        requestId: "request-new",
        command: "annotate",
        input: { summary: "new" },
      }),
    );

    expect(JSON.parse(sockets[1]!.sent.at(-1)!)).toMatchObject({
      requestId: "request-new",
      error: "queue-full",
    });
    connection.stop();
  });

  test("serializes bridge execution while preserving arrival order", async () => {
    const socket = new TestSocket();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      bridge: {
        dispatchCommand: async (message) => {
          started.push(message.requestId);
          if (message.requestId === "request-1") await firstGate;
          return { ok: true };
        },
      },
    });
    connection.start();
    socket.emitOpen();
    for (const requestId of ["request-1", "request-2"]) {
      socket.emitMessage(
        JSON.stringify({
          type: "command",
          requestId,
          command: "annotate",
          input: { summary: requestId },
        }),
      );
    }
    await Bun.sleep(0);
    expect(started).toEqual(["request-1"]);
    releaseFirst();
    await Bun.sleep(0);
    expect(started).toEqual(["request-1", "request-2"]);
    connection.stop();
  });

  test("rejects producer hello wrappers with unknown or dangerous keys", async () => {
    const producerAuthentication = await createProducerAuthenticationTest();
    const defectMessages: string[] = [];

    for (const message of [
      '{"type":"hello-challenge","challenge":{},"extra":true}',
      '{"type":"hello-challenge","challenge":{},"__proto__":{}}',
    ]) {
      const socket = new TestSocket();
      const connection = createSessionBrokerConnection({
        url: "ws://broker.test/session",
        createSocket: () => socket,
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        producerAuthentication,
        reconnectDelayMs: 10_000,
        onDefect: (defect) => defectMessages.push(defect),
      });
      connection.start();
      socket.emitOpen();
      socket.emitMessage(message);
      await Bun.sleep(0);

      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Session broker authentication failed.",
      });
      expect(defectMessages).toEqual([]);
      connection.stop();
    }
    expect(defectMessages).toEqual([]);
  });

  test("retries a transient synchronous socket factory failure during reconnect", async () => {
    const clock = new DeterministicLifecycleClockTest();
    const sockets: TestSocket[] = [];
    const warnings: string[] = [];
    let constructionAttempts = 0;
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        constructionAttempts += 1;
        if (constructionAttempts === 2) throw new Error("transient socket factory failure");
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 10,
      lifecycleClock: clock,
      onWarning: (message) => warnings.push(message),
    });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose();
    await clock.advanceByTestAsync(10);
    expect({ constructionAttempts, warnings, sockets: sockets.length }).toEqual({
      constructionAttempts: 2,
      warnings: ["transient socket factory failure"],
      sockets: 1,
    });
    expect(clock.pendingCountTest()).toBe(1);

    await clock.advanceByTestAsync(10);
    expect(constructionAttempts).toBe(3);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ type: "register" });
    connection.stop();
  });

  test("prepares reconnect once per attempt and stops after awaited preparation", async () => {
    const sockets: TestSocket[] = [];
    const warnings: string[] = [];
    let attempts = 0;
    let markSecondSocketCreated!: () => void;
    const secondSocketCreated = new Promise<void>((resolve) => (markSecondSocketCreated = resolve));
    let prepare = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("incumbent still alive");
    };
    const connection = createSessionBrokerConnection({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        if (sockets.length === 2) markSecondSocketCreated();
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 1,
      prepareReconnect: () => prepare(),
      onWarning: (message) => warnings.push(message),
    });
    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose();
    await secondSocketCreated;

    expect(attempts).toBe(2);
    expect(warnings).toEqual(["incumbent still alive"]);
    expect(sockets).toHaveLength(2);

    let release!: () => void;
    let markPreparationStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const preparationStarted = new Promise<void>((resolve) => (markPreparationStarted = resolve));
    sockets[1]!.emitOpen();
    prepare = () => {
      markPreparationStarted();
      return gate;
    };
    sockets[1]!.emitClose();
    await preparationStarted;
    connection.stop();
    release();
    await Bun.sleep(0);
    expect(sockets).toHaveLength(2);
  });

  test("explicitly starts a fresh generation after a natural no-reconnect close", async () => {
    const sockets: TestSocket[] = [];
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      resolveClose: () => ({ reconnect: false }),
    });

    connection.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitClose(1000, "complete");
    await Bun.sleep(0);
    expect(sockets).toHaveLength(1);

    connection.start();
    sockets[1]!.emitOpen();
    expect(sockets).toHaveLength(2);
    expect(sockets.map((socket) => (JSON.parse(socket.sent[0]!) as { type: string }).type)).toEqual(
      ["register", "register"],
    );
    connection.stop();
  });

  for (const outcome of ["resolve", "reject"] as const) {
    test(`stop fences late reconnect preparation ${outcome} without warning or another socket`, async () => {
      const sockets: TestSocket[] = [];
      const warnings: string[] = [];
      const preparationStarted = createDeferredTest();
      const preparationGate = createDeferredTest();
      const preparationSettled = createDeferredTest();
      const connection = createSessionBrokerConnection<
        TestSessionInfo,
        TestSessionState,
        TestSocket,
        TestServerMessage,
        { ok: true }
      >({
        url: "ws://broker.test/session",
        createSocket: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        reconnectDelayMs: 1,
        prepareReconnect: async () => {
          preparationStarted.resolve();
          try {
            await preparationGate.promise;
            if (outcome === "reject") throw new Error("late preparation failure");
          } finally {
            preparationSettled.resolve();
          }
        },
        onWarning: (message) => warnings.push(message),
      });

      connection.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitClose();
      await settleWithinTestTimeout(preparationStarted.promise);
      connection.stop();
      preparationGate.resolve();
      await settleWithinTestTimeout(preparationSettled.promise);
      await Bun.sleep(5);

      expect(warnings).toEqual([]);
      expect(sockets).toHaveLength(1);
    });
  }

  for (const outcome of ["resolve", "reject"] as const) {
    test(`replacement generation fences stale reconnect preparation ${outcome}`, async () => {
      const clock = new DeterministicLifecycleClockTest();
      const sockets: TestSocket[] = [];
      const warnings: string[] = [];
      const preparationStarted = createDeferredTest();
      const preparationGate = createDeferredTest();
      const callbackGenerations: number[] = [];
      const connection = createSessionBrokerConnection<
        TestSessionInfo,
        TestSessionState,
        TestSocket,
        TestServerMessage,
        { ok: true }
      >({
        url: "ws://broker.test/session",
        createSocket: () => {
          const socket = new TestSocket();
          sockets.push(socket);
          return socket;
        },
        registration: createRegistration(),
        snapshot: createSnapshot(),
        protocolParsers,
        reconnectDelayMs: 10,
        lifecycleClock: clock,
        prepareReconnect: async (generation) => {
          callbackGenerations.push(generation.id);
          preparationStarted.resolve();
          await preparationGate.promise;
          if (outcome === "reject") throw new Error("stale preparation failure");
        },
        onWarning: (message) => warnings.push(message),
      });

      connection.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitClose();
      clock.advanceByTest(10);
      await settleWithinTestTimeout(preparationStarted.promise);

      connection.start();
      sockets[1]!.emitOpen();
      preparationGate.resolve();
      await clock.flushMicrotasksTest();
      clock.advanceByTest(20);

      expect(callbackGenerations).toHaveLength(1);
      expect(warnings).toEqual([]);
      expect(sockets).toHaveLength(2);
      expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({
        type: "register",
      });
      connection.stop();
    });
  }

  test("reconnects after socket close unless a close directive disables it", async () => {
    const sockets: TestSocket[] = [];
    const warnings: string[] = [];
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
      registration: createRegistration(),
      snapshot: createSnapshot(),
      protocolParsers,
      reconnectDelayMs: 5,
      resolveClose: (event) =>
        event.reason === "stop"
          ? { reconnect: false, warning: "Stopped reconnecting." }
          : { reconnect: true },
      onWarning: (message) => warnings.push(message),
    });

    connection.start();
    sockets[0]?.emitOpen();
    sockets[0]?.emitClose(1008, "retry");
    await Bun.sleep(15);
    expect(sockets).toHaveLength(2);

    sockets[1]?.emitClose(1008, "stop");
    await Bun.sleep(15);
    expect(warnings).toEqual(["Stopped reconnecting."]);
    expect(sockets).toHaveLength(2);
  });
});
