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
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
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
