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
import { createSessionBrokerConnection } from "./connection";
import { createSessionBrokerProtocolParsers } from "./protocolParsers";
import type { SessionBrokerSocketLike } from "./types";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

type TestServerMessage = SessionServerMessage<"annotate", { summary: string }>;

class TestSocket implements SessionBrokerSocketLike {
  readyState = 0;
  sent: string[] = [];
  throwOnSend = false;
  lastClose: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    if (this.throwOnSend) throw new Error("socket exploded");
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

  test("withholds registration and replacement updates until producer authentication completes", async () => {
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
    });

    connection.start();
    socket.emitOpen();
    connection.updateSnapshot({
      ...createSnapshot(),
      state: { selectedIndex: 2 },
    });
    connection.replaceSession(createRegistration(), createSnapshot());

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "hello-init" });
    connection.stop();
  });

  test("keeps the previous registration when replacement send throws", () => {
    const socket = new TestSocket();
    const registration = createRegistration();
    const connection = createSessionBrokerConnection<
      TestSessionInfo,
      TestSessionState,
      TestSocket,
      TestServerMessage,
      { ok: true }
    >({
      url: "ws://broker.test/session",
      createSocket: () => socket,
      registration,
      snapshot: createSnapshot(),
      protocolParsers,
    });
    connection.start();
    socket.emitOpen();
    socket.throwOnSend = true;

    expect(() =>
      connection.replaceSession(
        { ...registration, sessionId: "session-2" },
        { ...createSnapshot(), state: { selectedIndex: 2 } },
      ),
    ).toThrow("socket exploded");
    expect(connection.getRegistration()).toBe(registration);
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
    const socket = new TestSocket();
    let dispatched = 0;
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
    });
    connection.start();
    socket.emitOpen();

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
      socket.readyState = 1;
      socket.emitMessage(JSON.stringify(message));
      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Malformed session broker command.",
      });
    }
    await Bun.sleep(0);
    expect(dispatched).toBe(0);
    connection.stop();
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
    expect({ inputCalls, bridgeCalls }).toEqual({ inputCalls: 1, bridgeCalls: 1 });

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
    expect(emitRejected("{".repeat(maxBytes + 1))).toMatchObject({ code: 1009 });
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
    expect(emitRejected(new Uint8Array([123, 125]))).toMatchObject({ code: 1003 });
    expect({ inputCalls, bridgeCalls }).toEqual({ inputCalls: 1, bridgeCalls: 1 });
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

    expect({ inputCalls, bridgeCalls }).toEqual({ inputCalls: 0, bridgeCalls: 0 });
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
    const overflow = JSON.parse(socket.sent.at(-1)!) as { requestId: string; error: string };
    expect(overflow).toMatchObject({ requestId: "request-33", error: "queue-full" });

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
      operations: ["register"],
    };
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
      reconnectDelayMs: 10_000,
    });
    connection.start();
    socket.emitOpen();

    for (const message of [
      '{"type":"hello-challenge","challenge":{},"extra":true}',
      '{"type":"hello-challenge","challenge":{},"__proto__":{}}',
    ]) {
      socket.readyState = 1;
      socket.emitMessage(message);
      expect(socket.lastClose).toEqual({
        code: 1008,
        reason: "Session broker authentication failed.",
      });
    }
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
