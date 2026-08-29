import { describe, expect, test } from "bun:test";
import {
  SESSION_BROKER_REGISTRATION_VERSION,
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
  type CallerPrincipal,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import { SessionBroker } from "./broker";
import { createSessionBrokerDaemon } from "./daemon";
import type { AuthenticatedCallerRequest } from "./authentication";

interface TestSessionInfo {
  title: string;
}

interface TestSessionState {
  selectedIndex: number;
}

type TestRegistration = SessionRegistration<TestSessionInfo>;
type TestSnapshot = SessionSnapshot<TestSessionState>;
type TestServerMessage = SessionServerMessage<"annotate", { summary: string }>;

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

function createBroker() {
  return new SessionBroker<TestSessionInfo, TestSessionState, TestServerMessage>({
    parseRegistration: (value) => parseSessionRegistrationEnvelope(value, parseInfo),
    parseSnapshot: (value) => parseSessionSnapshotEnvelope(value, parseState),
  });
}

function createRegistration(overrides: Partial<TestRegistration> = {}): TestRegistration {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-04-15T00:00:00.000Z",
    info: { title: "repo working tree" },
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<TestSnapshot["state"]> & { updatedAt?: string } = {},
): TestSnapshot {
  const { updatedAt = "2026-04-15T00:00:00.000Z", ...stateOverrides } = overrides;

  return {
    updatedAt,
    state: {
      selectedIndex: 0,
      ...stateOverrides,
    },
  };
}

function authenticatedRequest(principal: CallerPrincipal): AuthenticatedCallerRequest {
  return {
    principal,
    requestId: "request-1",
    assertActive() {},
    async signResponse(input) {
      return {
        generation: "generation-1",
        brokerRevision: 1,
        ...(input.appContract ? { appContract: input.appContract } : {}),
        requestId: "request-1",
        httpStatus: input.httpStatus,
        bodyDigest: "test-body-digest",
        daemonKeyId: "daemon-key-1",
        daemonSignature: "test-signature",
      };
    },
  };
}

const authenticatedHttpApi = {
  appId: "session-broker",
  appRevision: 1,
  callerAuthenticator: {
    authenticate: async () =>
      authenticatedRequest({
        kind: "caller" as const,
        appId: "session-broker",
        principalId: "test-caller",
        keyId: "test-key",
        grantId: "test-grant",
        operations: ["list", "get", "dispatch", "diagnostics"] as const,
        commands: [
          { name: "annotate", version: 1 },
          { name: "annotate", version: 2 },
        ],
      }),
  },
  authorizer: async () => true,
};

async function authenticatedBody(response: Response | null) {
  const envelope = (await response?.json()) as { body: unknown } | undefined;
  return envelope?.body;
}

function createConnection() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | null = null;

  return {
    sent,
    get closed() {
      return closed;
    },
    connection: {
      send(data: string) {
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closed = { code, reason };
      },
    },
  };
}

describe("session broker daemon", () => {
  test("serves health and raw list/get requests when the HTTP API is enabled", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1, name: "test-broker" },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });
    const { connection } = createConnection();
    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "register",
        registration: createRegistration(),
        snapshot: createSnapshot(),
      }),
    );

    await expect(
      daemon.handleRequest(new Request("http://broker.test/health")),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      daemon.handleRequest(new Request("http://broker.test/broker/capabilities")),
    ).resolves.toBeInstanceOf(Response);

    const listResponse = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }),
    );
    expect(listResponse).toBeInstanceOf(Response);
    await expect(authenticatedBody(listResponse)).resolves.toMatchObject({
      sessions: [{ sessionId: "session-1", title: "repo working tree" }],
    });

    const getResponse = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "get", selector: { sessionId: "session-1" } }),
      }),
    );
    await expect(authenticatedBody(getResponse)).resolves.toMatchObject({
      session: {
        registration: { sessionId: "session-1" },
        snapshot: { state: { selectedIndex: 0 } },
      },
    });

    daemon.shutdown();
  });

  test("refuses exposeHttpApi without both an explicit authenticator and authorizer", async () => {
    const withoutAuthentication = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      appId: "session-broker",
    });
    const withoutAuthorization = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      appId: "session-broker",
      callerAuthenticator: authenticatedHttpApi.callerAuthenticator,
    });

    for (const daemon of [withoutAuthentication, withoutAuthorization]) {
      expect(daemon.paths).toEqual({ health: "/health", socket: "/session" });
      await expect(
        daemon.handleRequest(
          new Request("http://broker.test/broker", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "list" }),
          }),
        ),
      ).resolves.toBeNull();
      daemon.shutdown();
    }
  });

  test("requires GET with an empty body for authenticated capabilities", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });

    const response = await daemon.handleRequest(
      new Request("http://broker.test/broker/capabilities", {
        method: "POST",
        body: "unsigned bytes",
      }),
    );

    expect(response?.status).toBe(405);
    daemon.shutdown();
  });

  test("does not expose the raw broker HTTP API by default", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
    });

    await expect(
      daemon.handleRequest(new Request("http://broker.test/broker/capabilities")),
    ).resolves.toBeNull();

    await expect(
      daemon.handleRequest(
        new Request("http://broker.test/broker", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "list" }),
        }),
      ),
    ).resolves.toBeNull();

    await expect(
      daemon.handleRequest(new Request("http://broker.test/health")),
    ).resolves.toBeInstanceOf(Response);
    expect(daemon.paths).toEqual({ health: "/health", socket: "/session" });
    daemon.shutdown();
  });

  test("requires JSON content type for raw broker API posts", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });

    const response = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ action: "list" }),
      }),
    );

    expect(response?.status).toBe(415);
    await expect(response?.json()).resolves.toEqual({
      error: "Expected Content-Type application/json.",
    });
    daemon.shutdown();
  });

  test("authenticates exact body bytes before strictly rejecting BOM and malformed UTF-8", async () => {
    const authenticatedBodies: number[][] = [];
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      exposeHttpApi: true,
      appId: "session-broker",
      appRevision: 1,
      callerAuthenticator: {
        authenticate: async ({ body }) => {
          authenticatedBodies.push([...body]);
          return authenticatedRequest({
            kind: "caller",
            appId: "session-broker",
            principalId: "test-caller",
            keyId: "test-key",
            grantId: "test-grant",
            operations: ["list"],
            commands: [],
          });
        },
      },
      authorizer: async () => true,
    });
    const malformedBodies = [
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"action":"list"}')]),
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc0, 0xaf, 0x7d]),
    ];
    for (const body of malformedBodies) {
      const response = await daemon.handleRequest(
        new Request("http://broker.test/broker", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response?.status).toBe(400);
    }
    expect(authenticatedBodies).toEqual(malformedBodies.map((body) => [...body]));
    daemon.shutdown();
  });

  test("rejects raw broker API bodies that exceed the size limit", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });

    const oversized = JSON.stringify({ action: "list", filler: "x".repeat(5 * 1024 * 1024) });
    const response = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      }),
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringContaining("session broker limit"),
    });
    daemon.shutdown();
  });

  test("dispatches one raw command through the broker API", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });
    const session = createConnection();
    const { connection, sent } = session;
    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "register",
        registration: createRegistration(),
        snapshot: createSnapshot(),
      }),
    );

    const pendingResponse = daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "dispatch",
          selector: { sessionId: "session-1" },
          command: "annotate",
          commandVersion: 2,
          input: { summary: "Review note" },
        }),
      }),
    );

    await Bun.sleep(0);
    const outgoing = JSON.parse(sent[sent.length - 1]!) as {
      requestId: string;
      command: string;
      commandVersion: number;
    };
    expect(outgoing).toMatchObject({ command: "annotate", commandVersion: 2 });

    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "command-result",
        requestId: outgoing.requestId,
        ok: true,
        result: { applied: true },
      }),
    );

    const response = await pendingResponse;
    await expect(authenticatedBody(response)).resolves.toEqual({ result: { applied: true } });
    daemon.shutdown();
  });

  test("closes snapshot assertions from unregistered peers", () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
    });
    const session = createConnection();
    const { connection } = session;

    daemon.handleConnectionMessage(
      connection,
      JSON.stringify({
        type: "snapshot",
        sessionId: "missing-session",
        snapshot: createSnapshot(),
      }),
    );

    expect(session.closed).toEqual({
      code: 1008,
      reason: "Session ownership rejected.",
    });
    daemon.shutdown();
  });

  test("rejects duplicate live registration without retiring the owner", () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
    });
    const owner = createConnection();
    const duplicate = createConnection();
    const register = JSON.stringify({
      type: "register",
      registration: createRegistration(),
      snapshot: createSnapshot(),
    });

    daemon.handleConnectionMessage(owner.connection, register);
    daemon.handleConnectionMessage(duplicate.connection, register);

    expect(duplicate.closed).toEqual({ code: 1008, reason: "Session registration rejected." });
    daemon.handleConnectionClose(duplicate.connection);
    expect(daemon.listSessions()).toHaveLength(1);
    expect(daemon.listSessions()[0]).toMatchObject({ sessionId: "session-1" });
    daemon.shutdown();
  });

  test("rejects cross-peer snapshot, heartbeat, and result authority", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      ...authenticatedHttpApi,
    });
    const owner = createConnection();
    const snapshotPeer = createConnection();
    const heartbeatPeer = createConnection();
    const resultPeer = createConnection();

    for (const [session, sessionId] of [
      [owner, "session-1"],
      [snapshotPeer, "session-2"],
      [heartbeatPeer, "session-3"],
      [resultPeer, "session-4"],
    ] as const) {
      daemon.handleConnectionMessage(
        session.connection,
        JSON.stringify({
          type: "register",
          registration: createRegistration({ sessionId, cwd: `/${sessionId}` }),
          snapshot: createSnapshot(),
        }),
      );
    }

    daemon.handleConnectionMessage(
      snapshotPeer.connection,
      JSON.stringify({
        type: "snapshot",
        sessionId: "session-1",
        snapshot: createSnapshot({ updatedAt: "2026-04-15T00:00:01.000Z", selectedIndex: 1 }),
      }),
    );
    expect(snapshotPeer.closed).toEqual({ code: 1008, reason: "Session ownership rejected." });
    expect(daemon.getSession({ sessionId: "session-1" })).toMatchObject({
      snapshot: { state: { selectedIndex: 0 } },
    });

    const ownerSeenAt = daemon.getSession({ sessionId: "session-1" }).lastSeenAt;
    daemon.handleConnectionMessage(
      heartbeatPeer.connection,
      JSON.stringify({ type: "heartbeat", sessionId: "session-1" }),
    );
    expect(heartbeatPeer.closed).toEqual({ code: 1008, reason: "Session ownership rejected." });
    expect(daemon.getSession({ sessionId: "session-1" }).lastSeenAt).toBe(ownerSeenAt);

    const pendingResponse = daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "dispatch",
          selector: { sessionId: "session-1" },
          command: "annotate",
          input: { summary: "Review note" },
        }),
      }),
    );
    await Bun.sleep(0);
    const outgoing = JSON.parse(owner.sent.at(-1)!) as { requestId: string };

    daemon.handleConnectionMessage(
      resultPeer.connection,
      JSON.stringify({
        type: "command-result",
        requestId: outgoing.requestId,
        ok: true,
        result: { applied: "forged" },
      }),
    );
    expect(resultPeer.closed).toEqual({ code: 1008, reason: "Command ownership rejected." });
    expect(daemon.getHealth().pendingCommands).toBe(1);

    daemon.handleConnectionMessage(
      owner.connection,
      JSON.stringify({
        type: "command-result",
        requestId: outgoing.requestId,
        ok: true,
        result: { applied: true },
      }),
    );
    const response = await pendingResponse;
    await expect(authenticatedBody(response)).resolves.toEqual({ result: { applied: true } });
    daemon.shutdown();
  });

  test("requires operation, command, and app authorization before broker control", async () => {
    let appAuthorizerCalls = 0;
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      capabilities: { version: 1 },
      exposeHttpApi: true,
      appId: "session-broker",
      appRevision: 1,
      callerAuthenticator: {
        authenticate: async () =>
          authenticatedRequest({
            kind: "caller" as const,
            appId: "session-broker",
            principalId: "limited-caller",
            keyId: "limited-key",
            grantId: "limited-grant",
            operations: ["list", "dispatch"] as const,
            commands: [{ name: "allowed", version: 1 }],
          }),
      },
      authorizer: async () => {
        appAuthorizerCalls += 1;
        return true;
      },
    });
    const post = (body: unknown) =>
      daemon.handleRequest(
        new Request("http://broker.test/broker", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect((await post({ action: "get", selector: { sessionId: "missing" } }))?.status).toBe(403);
    expect(appAuthorizerCalls).toBe(0);
    expect(
      (
        await post({
          action: "dispatch",
          selector: { sessionId: "missing" },
          command: "forbidden",
          input: {},
        })
      )?.status,
    ).toBe(403);
    expect(appAuthorizerCalls).toBe(0);
    expect(
      (
        await post({
          action: "dispatch",
          selector: { sessionId: "missing" },
          command: "allowed",
          commandVersion: 0,
          input: {},
        })
      )?.status,
    ).toBe(400);
    expect(appAuthorizerCalls).toBe(0);
    expect((await post({ action: "list" }))?.status).toBe(200);
    expect(appAuthorizerCalls).toBe(1);
    daemon.shutdown();
  });

  test("returns stable redacted authentication failures without invoking app authorization", async () => {
    let authorized = false;
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      exposeHttpApi: true,
      appId: "session-broker",
      appRevision: 1,
      callerAuthenticator: {
        authenticate: async () => {
          const { SessionBrokerAuthenticationError } = await import("./authentication");
          throw new SessionBrokerAuthenticationError("invalid-signature");
        },
      },
      authorizer: async () => {
        authorized = true;
        return true;
      },
    });
    const response = await daemon.handleRequest(
      new Request("http://broker.test/broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }),
    );
    expect(response?.status).toBe(401);
    const responseText = await response?.text();
    expect(JSON.parse(responseText ?? "null")).toEqual({
      error: "authentication-failed",
      code: "invalid-signature",
    });
    expect(authorized).toBe(false);
    expect(responseText).not.toContain("private");
    daemon.shutdown();
  });

  test("requests shutdown after the idle timeout when no sessions remain", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      idleTimeoutMs: 20,
      staleSessionSweepIntervalMs: 10,
      capabilities: { version: 1 },
    });

    await expect(daemon.stopped).resolves.toBeUndefined();
  });
});
