import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type SessionRegistration,
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
  test("uses the shared binary, oversize, and pressure close corpus", () => {
    expect(SESSION_BROKER_ADAPTER_CONFORMANCE).toMatchObject({
      textOnly: { binaryCloseCode: 1003 },
      inbound: { oversizedCloseCode: 1009, pressureCloseCode: 1013 },
    });
  });

  test("closes binary, oversized, and aggregate-pressure messages per the shared corpus", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxWsMessageBytes: 8, maxInFlightWsBytes: 0 },
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
      expect(await oversizedClosed).toBe(
        SESSION_BROKER_ADAPTER_CONFORMANCE.inbound.oversizedCloseCode,
      );

      const pressure = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      const pressureClosed = testSocketCloseCode(pressure);
      pressure.send("{}");
      expect(await pressureClosed).toBe(
        SESSION_BROKER_ADAPTER_CONFORMANCE.inbound.pressureCloseCode,
      );
    } finally {
      server.stop(true);
      await server.stopped;
    }
  });

  test("admits exactly the configured number of active websocket peers", async () => {
    const broker = new SessionBroker({ protocolParsers });
    const daemon = createSessionBrokerDaemon({
      broker,
      limits: { maxUnauthenticatedSockets: 1 },
    });
    const port = await reserveLoopbackPort();
    const server = serveSessionBrokerDaemon({ daemon, hostname: "127.0.0.1", port });
    try {
      const first = await openTestSocket(`ws://127.0.0.1:${port}/session`);
      await expect(openTestSocket(`ws://127.0.0.1:${port}/session`)).rejects.toThrow();
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
            requestId: "request-1",
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
