import { describe, expect, test } from "bun:test";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
} from "@hunk/session-broker-core";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { createSessionBrokerConnection } from "./connection";
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
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    if (this.throwOnSend) throw new Error("socket exploded");
    this.sent.push(data);
  }

  close() {
    this.emitClose();
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
    });

    connection.start();
    sockets[0]?.emitOpen();

    const registerMessage = JSON.parse(sockets[0]!.sent[0]!) as { type: string };
    expect(registerMessage.type).toBe("register");

    connection.updateSnapshot({
      updatedAt: "2026-04-15T00:00:01.000Z",
      state: { selectedIndex: 1 },
    });

    const snapshotMessage = JSON.parse(sockets[0]!.sent[1]!) as { type: string; snapshot: unknown };
    expect(snapshotMessage.type).toBe("snapshot");
    expect(snapshotMessage.snapshot).toEqual({
      updatedAt: "2026-04-15T00:00:01.000Z",
      state: { selectedIndex: 1 },
    });
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
