import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import {
  BrokerCapacityError,
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import {
  SessionBroker,
  createSessionBrokerDaemon,
  createSessionBrokerProtocolParsers,
} from "@hunk/session-broker";
import SESSION_BROKER_ADAPTER_CONFORMANCE from "../../../test/fixtures/sessionBrokerAdapterConformance.json" with { type: "json" };
import { serveSessionBrokerDaemon } from "./serve";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

function parseInfo(value: unknown): TestSessionInfo | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const title = brokerWireParsers.parseRequiredString(record.title);
  return title === null ? null : { title };
}

function parseState(value: unknown): TestSessionState | null {
  const record = brokerWireParsers.asRecord(value);
  if (!record) {
    return null;
  }

  const selectedIndex = brokerWireParsers.parseNonNegativeInt(record.selectedIndex);
  return selectedIndex === null ? null : { selectedIndex };
}

function createRegistration(overrides: Partial<SessionRegistration<TestSessionInfo>> = {}) {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: process.pid,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    info: { title: "repo working tree" },
    ...overrides,
  } satisfies SessionRegistration<TestSessionInfo>;
}

function createSnapshot(
  overrides: Partial<SessionSnapshot<TestSessionState>["state"]> & {
    updatedAt?: string;
  } = {},
) {
  const { updatedAt = "2026-04-15T00:00:00.000Z", ...stateOverrides } = overrides;
  return {
    updatedAt,
    state: {
      selectedIndex: 0,
      ...stateOverrides,
    },
  } satisfies SessionSnapshot<TestSessionState>;
}

const protocolParsers = createSessionBrokerProtocolParsers({
  appRevision: 1,
  features: [],
  parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
  parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  commands: [],
});

async function reserveLoopbackPort() {
  const listener = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 1_500,
  intervalMs = 20,
) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await Bun.sleep(intervalMs);
  }
}

/** Return the HTTP status from one raw WebSocket upgrade attempt. */
async function rawWebSocketUpgradeStatus(port: number) {
  return await new Promise<number>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        [
          "GET /session HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGVzdC1zZXNzaW9uLWtleQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      socket.destroy();
      if (Number.isInteger(status)) resolve(status);
      else reject(new Error("WebSocket upgrade returned an invalid HTTP response."));
    });
    socket.on("error", reject);
  });
}

async function openTestSocket(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open.")),
      1_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Websocket failed to open."));
      },
      { once: true },
    );
  });
  return socket;
}

function testSocketCloseCode(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket close.")),
      1_000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event.code);
      },
      { once: true },
    );
    socket.addEventListener("error", () => {}, { once: true });
  });
}

async function readHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

async function waitForSessionCount(port: number, count: number) {
  await waitUntil("session registration", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/broker`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      body: { sessions: { sessionId: string }[] };
    };
    return payload.body.sessions.length === count ? payload : null;
  });
}

afterEach(() => {
  // No per-test env state to restore yet.
});

describe("session broker bun adapter", () => {
  test("closes binary and oversized messages per the shared corpus", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxWsMessageBytes: 8 },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const binary = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      const binaryClosed = testSocketCloseCode(binary);
      binary.send(new Uint8Array([1]));
      expect(await binaryClosed).toBe(SESSION_BROKER_ADAPTER_CONFORMANCE.textOnly.binaryCloseCode);

      const oversized = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      const oversizedClosed = testSocketCloseCode(oversized);
      oversized.send("123456789");
      expect(SESSION_BROKER_ADAPTER_CONFORMANCE.inbound.bunNativeOversizedCloseCodes).toContain(
        await oversizedClosed,
      );
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("returns the shared HTTP status when socket admission is full and releases on close", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxUnauthenticatedSockets: 1, maxHandshakeDurationMs: 1_000 },
      helloAuthenticator: {} as never,
      producerEndpoint: "ws://127.0.0.1/session",
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const first = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      expect(await rawWebSocketUpgradeStatus(port)).toBe(
        SESSION_BROKER_ADAPTER_CONFORMANCE.inbound.admissionHttpStatus,
      );
      const closed = testSocketCloseCode(first);
      first.close();
      await closed;
      const afterRelease = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      afterRelease.close();
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("contains handler failures and closes the affected peer", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({ broker });
    daemon.handleConnectionMessage = (_peer, message) => {
      if (message === "capacity") throw new BrokerCapacityError("busy", "test");
      throw new Error("unexpected handler failure");
    };
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const capacity = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      const capacityClosed = testSocketCloseCode(capacity);
      capacity.send("capacity");
      expect(await capacityClosed).toBe(1013);

      const unexpected = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      const unexpectedClosed = testSocketCloseCode(unexpected);
      unexpected.send("unexpected");
      expect(await unexpectedClosed).toBe(1011);
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("accepts a websocket message exactly at the configured byte ceiling", async () => {
    const message = JSON.stringify({
      type: "register",
      registration: createRegistration(),
      snapshot: createSnapshot(),
    });
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxWsMessageBytes: new TextEncoder().encode(message).byteLength },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const socket = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      socket.send(message);
      await waitUntil("exact-ceiling registration", () =>
        broker.listSessions().length === 1 ? true : null,
      );
      socket.close();
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("closes outbound aggregate pressure and releases socket capacity for reconnect", async () => {
    type PressureMessage = SessionServerMessage<"annotate", { summary: string }>;
    const pressureParsers = createSessionBrokerProtocolParsers<
      TestSessionInfo,
      TestSessionState,
      PressureMessage,
      { applied: true }
    >({
      appRevision: 1,
      features: [],
      parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
      parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
      commands: [
        {
          command: "annotate",
          version: 1,
          parseInput: (value) =>
            typeof (value as { summary?: unknown })?.summary === "string"
              ? { summary: (value as { summary: string }).summary }
              : null,
          parseResult: (value) =>
            (value as { applied?: unknown })?.applied === true ? { applied: true } : null,
        },
      ],
    });
    const broker = new SessionBroker({ protocolParsers: pressureParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxOutboundBytesTotal: 8 },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const socket = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      socket.send(
        JSON.stringify({
          type: "register",
          registration: createRegistration(),
          snapshot: createSnapshot(),
        }),
      );
      await waitUntil("pressure registration", () =>
        broker.listSessions().length === 1 ? true : null,
      );
      const closed = testSocketCloseCode(socket);
      const dispatchResult = broker
        .dispatchCommand({
          selector: { sessionId: "session-1" },
          command: "annotate",
          input: { summary: "pressure" },
          timeoutMessage: "timeout",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(await closed).toBe(SESSION_BROKER_ADAPTER_CONFORMANCE.outbound.pressureCloseCode);
      expect(await dispatchResult).toBeInstanceOf(Error);
      await waitUntil("pressure disconnect cleanup", () =>
        broker.listSessions().length === 0 ? true : null,
      );

      const afterRelease = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      afterRelease.close();
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("manual stop retires peer admission and rejects late message delivery", async () => {
    let snapshotCalls = 0;
    const countingParsers = createSessionBrokerProtocolParsers({
      appRevision: 1,
      features: [],
      parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
      parseSnapshot: (value) => {
        snapshotCalls += 1;
        return parseSessionSnapshotEnvelope(value, parseState);
      },
      commands: [],
    });
    const broker = new SessionBroker({ protocolParsers: countingParsers });
    const daemon = createSessionBrokerDaemon({ broker });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    const socket = await openTestSocket(`ws://127.0.0.1:${port}/session`);
    socket.send(
      JSON.stringify({
        type: "register",
        registration: createRegistration(),
        snapshot: createSnapshot(),
      }),
    );
    await waitUntil("initial snapshot parse", () => (snapshotCalls === 1 ? true : null));

    let peerRetired = false;
    let transportSettled = false;
    let stoppedSettled = false;
    const closed = testSocketCloseCode(socket).then(() => {
      peerRetired = true;
    });
    const stopResult = Promise.resolve(server.stop(false)).then(() => {
      transportSettled = true;
    });
    const stopped = server.stopped.then(() => {
      stoppedSettled = true;
    });
    try {
      socket.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: "session-1",
          snapshot: createSnapshot({ selectedIndex: 1 }),
        }),
      );
    } catch {
      // A runtime may reject the send synchronously once forced shutdown begins.
    }
    await stopped;
    try {
      socket.send(
        JSON.stringify({
          type: "snapshot",
          sessionId: "session-1",
          snapshot: createSnapshot({ selectedIndex: 2 }),
        }),
      );
    } catch {
      // The peer may already observe the forced close.
    }
    await Bun.sleep(20);
    await Promise.all([closed, stopResult]);

    expect(snapshotCalls).toBe(1);
    expect({ peerRetired, transportSettled, stoppedSettled }).toEqual({
      peerRetired: true,
      transportSettled: true,
      stoppedSettled: true,
    });
  });

  test("waits for an active custom HTTP handler before resolving stopped", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({ broker });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
      handleRequest: async () => {
        enter();
        await gate;
        return new Response("done");
      },
    });
    const request = fetch(`http://127.0.0.1:${port}/deferred`).catch(() => null);
    await entered;
    let stoppedSettled = false;
    const stopped = server.stopped.then(() => {
      stoppedSettled = true;
    });
    const transportStop = Promise.resolve(server.stop(true));
    await Bun.sleep(20);
    expect(stoppedSettled).toBe(false);
    release();
    await Promise.all([request, transportStop, stopped]);
    expect(stoppedSettled).toBe(true);
  });

  test("admits exactly the configured number of unauthenticated websocket peers", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxUnauthenticatedSockets: 1, maxHandshakeDurationMs: 50 },
      helloAuthenticator: {} as never,
      producerEndpoint: "ws://127.0.0.1/session",
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const first = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      await expect(openTestSocket(`ws://127.0.0.1:${port}/session`)).rejects.toThrow();
      const closed = testSocketCloseCode(first);
      expect(await closed).toBe(1008);
      const afterRelease = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      afterRelease.close();
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("serves the generic daemon API and websocket path through Bun", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      capabilities: { version: 1 },
      exposeHttpApi: true,
      appId: "test.app",
      appRevision: 1,
      callerAuthenticator: {
        authenticate: async () => ({
          principal: {
            kind: "caller" as const,
            appId: "test.app",
            principalId: "test-caller",
            keyId: "test-key",
            grantId: "test-grant",
            operations: ["list", "get"] as const,
            commands: [],
          },
          requestId: "request-1",
          assertActive() {},
          signResponse: async ({ httpStatus, appContract }) => ({
            generation: "generation-1",
            brokerRevision: 1 as const,
            ...(appContract ? { appContract } : {}),
            callerSessionId: "caller-session-1",
            requestId: "request-1",
            sequence: "1",
            httpStatus,
            bodyDigest: "test-digest",
            daemonKeyId: "daemon-key-1",
            daemonSignature: "test-signature",
          }),
        }),
      },
      authorizer: async () => true,
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
    });

    try {
      await expect(readHealth(port)).resolves.toMatchObject({ ok: true });

      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for websocket open.")),
          500,
        );
        timeout.unref?.();
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timeout);
            reject(new Error("Websocket failed to open."));
          },
          { once: true },
        );
      });

      socket.send(
        JSON.stringify({
          type: "register",
          registration: createRegistration(),
          snapshot: createSnapshot(),
        }),
      );

      await waitForSessionCount(port, 1);
      const response = await fetch(`http://127.0.0.1:${port}/broker`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "get",
          selector: { sessionId: "session-1" },
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        body: {
          session: {
            registration: { sessionId: "session-1" },
            snapshot: { state: { selectedIndex: 0 } },
          },
        },
      });

      socket.close();
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("serves a custom HTTP response exactly at the configured byte ceiling", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({ broker, limits: { maxHttpResponseBytes: 4 } });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
      handleRequest: () => new Response("1234"),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/exact`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("1234");
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("releases bounded response capacity when HEAD suppresses the body", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxHttpResponseBytes: 4, maxInFlightHttpResponseBytes: 8 },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
      handleRequest: () => new Response("1234"),
    });
    try {
      expect((await fetch(`http://127.0.0.1:${port}/head`, { method: "HEAD" })).status).toBe(200);
      const afterHead = await fetch(`http://127.0.0.1:${port}/after-head`);
      expect(afterHead.status).toBe(200);
      expect(await afterHead.text()).toBe("1234");
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("falls back to an empty 503 when even the capacity envelope exceeds the response cap", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({ broker, limits: { maxHttpResponseBytes: 1 } });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
      handleRequest: () => new Response("too large"),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/large`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("lets custom request handlers override generic routes", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      capabilities: { version: 1 },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port,
      handleRequest: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          return Response.json({ ok: true, overridden: true });
        }

        return undefined;
      },
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        overridden: true,
      });
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });
});
