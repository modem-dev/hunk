import {
  DEFAULT_SESSION_BROKER_API_PATH,
  SESSION_BROKER_ADMIN_SCOPE_VERSION,
  SESSION_BROKER_ADMIN_STOP_CLOSE_REASON,
  SESSION_BROKER_REGISTRATION_VERSION,
  SESSION_BROKER_SIGNATURE_ALGORITHM,
  SessionBroker,
  SessionBrokerAdminClient,
  SessionBrokerAuthenticator,
  SessionBrokerCallerClient,
  SessionBrokerClientAuthenticationError,
  createSessionBrokerConnection,
  createSessionBrokerDaemon,
  createSessionBrokerProtocolParsers,
  type CallerGrant,
  type ProducerGrant,
  type SessionBrokerDaemon,
  type SessionBrokerSocketLike,
  type SessionRegistration,
  type SessionSnapshot,
} from "@hunk/session-broker";
import { SessionBrokerClient } from "../../packages/hunk/src/session/broker/brokerClient";
import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
} from "../../packages/hunk/src/session/types";

interface RunningDaemon {
  stop(): void | Promise<void>;
  readonly stopped: Promise<void>;
}

class FixtureSocket implements SessionBrokerSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(_data: string) {}

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const protocolParsers = createSessionBrokerProtocolParsers({
  appRevision: 1,
  features: [],
  parseRegistration: (value) => value as SessionRegistration<unknown>,
  parseSnapshot: (value) => value as SessionSnapshot<unknown>,
  commands: [],
});

/** Build the stable registration and snapshot used by connection timer fixtures. */
function createConnectionOptions(createSocket: (url: string) => SessionBrokerSocketLike) {
  return {
    url: "ws://127.0.0.1/session",
    createSocket,
    registration: {
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "runtime-fixture",
      pid: process.pid,
      cwd: process.cwd(),
      launchedAt: new Date(0).toISOString(),
      info: {},
    },
    snapshot: {
      updatedAt: new Date(0).toISOString(),
      state: {},
    },
    protocolParsers,
    heartbeatIntervalMs: 60_000,
    reconnectDelayMs: 60_000,
  };
}

/** Generate one daemon identity and one independently signed producer grant in-process. */
async function createSignedProducerAuthentication() {
  const producerPair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const daemonPair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const grant: ProducerGrant = {
    kind: "producer",
    appId: "dev.example",
    principalId: "runtime-fixture",
    keyId: "runtime-fixture-key",
    grantId: "runtime-fixture-grant",
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revocationId: "runtime-fixture-revocation",
    mayDelegate: false,
    operations: ["register", "reconnect"],
  };
  const authenticator = new SessionBrokerAuthenticator({
    appId: grant.appId,
    appRevision: 1,
    generation: "runtime-fixture-generation",
    daemonIdentity: {
      keyId: "runtime-fixture-daemon",
      privateKey: daemonPair.privateKey,
    },
    credentials: [{ grant, publicKey: producerPair.publicKey }],
  });
  return {
    authenticator,
    connection: {
      appId: grant.appId,
      appRevision: 1,
      credential: { grant, privateKey: producerPair.privateKey },
      daemon: {
        keyId: "runtime-fixture-daemon",
        publicKey: daemonPair.publicKey,
      },
    },
  };
}

/** Wait until the actual broker has accepted the register message after signed hello. */
async function waitForRegistration(broker: { getSessionIds(): readonly string[] }) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (broker.getSessionIds().includes("runtime-fixture")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the signed producer register message.");
}

/** Exercise signed hello and registration through one runtime's native daemon and socket adapters. */
async function runSignedConnection({
  reservePort,
  createSocket,
  startDaemon,
}: RuntimeFixtureAdapter) {
  const port = await reservePort();
  const endpoint = `ws://127.0.0.1:${port}/session`;
  const authentication = await createSignedProducerAuthentication();
  const broker = new SessionBroker({ protocolParsers });
  const daemon = createSessionBrokerDaemon({
    broker,
    appId: "dev.example",
    producerEndpoint: endpoint,
    helloAuthenticator: authentication.authenticator,
    idleTimeoutMs: 0,
  });
  const running = await startDaemon(daemon, port);
  const connection = createSessionBrokerConnection({
    ...createConnectionOptions(createSocket),
    url: endpoint,
    producerAuthentication: authentication.connection,
  });
  try {
    connection.start();
    await waitForRegistration(broker);
    console.log("signed-producer-register-observed");
  } finally {
    connection.stop();
    await running.stop();
    await running.stopped;
  }
}

/** Generate one daemon identity plus signed producer and caller grants for the admin fixture. */
async function createAdminScopeAuthentication() {
  const generate = () =>
    crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const [producerPair, callerPair, daemonPair] = await Promise.all([
    generate(),
    generate(),
    generate(),
  ]);
  const common = {
    appId: "dev.example",
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    mayDelegate: false,
  } as const;
  const producerGrant: ProducerGrant = {
    ...common,
    kind: "producer",
    principalId: "runtime-fixture",
    keyId: "runtime-fixture-key",
    grantId: "runtime-fixture-grant",
    revocationId: "runtime-fixture-revocation",
    operations: ["register", "reconnect"],
  };
  const callerGrant: CallerGrant = {
    ...common,
    kind: "caller",
    principalId: "runtime-fixture-caller",
    keyId: "runtime-fixture-caller-key",
    grantId: "runtime-fixture-caller-grant",
    revocationId: "runtime-fixture-caller-revocation",
    operations: ["list", "get", "dispatch", "diagnostics"],
    commands: [],
  };
  const daemonIdentity = { keyId: "runtime-fixture-daemon", privateKey: daemonPair.privateKey };
  const credentials = [
    { grant: producerGrant, publicKey: producerPair.publicKey },
    { grant: callerGrant, publicKey: callerPair.publicKey },
  ];
  const daemonVerifier = { keyId: daemonIdentity.keyId, publicKey: daemonPair.publicKey };
  return {
    // The main authenticator speaks app revision 1; the admin one speaks only the frozen scope.
    authenticator: new SessionBrokerAuthenticator({
      appId: "dev.example",
      appRevision: 1,
      generation: "runtime-fixture-generation",
      daemonIdentity,
      credentials,
    }),
    adminAuthenticator: new SessionBrokerAuthenticator({
      appId: "dev.example",
      appRevision: SESSION_BROKER_ADMIN_SCOPE_VERSION,
      generation: "runtime-fixture-generation",
      daemonIdentity,
      credentials,
    }),
    producer: {
      appId: "dev.example",
      appRevision: 1,
      credential: { grant: producerGrant, privateKey: producerPair.privateKey },
      daemon: daemonVerifier,
    },
    caller: {
      credential: { grant: callerGrant, privateKey: callerPair.privateKey },
      daemon: daemonVerifier,
    },
  };
}

/**
 * Exercise the revision-tolerant admin scope: a caller built for a different app revision can
 * read `status` and issue `stop`, cannot reach the ordinary API, and attached producers see the
 * restart close reason.
 */
async function runAdminScope({ reservePort, createSocket, startDaemon }: RuntimeFixtureAdapter) {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = `ws://127.0.0.1:${port}/session`;
  const authentication = await createAdminScopeAuthentication();
  const broker = new SessionBroker({ protocolParsers });
  const daemon = createSessionBrokerDaemon({
    broker,
    appId: "dev.example",
    appRevision: 1,
    exposeHttpApi: true,
    producerEndpoint: endpoint,
    helloAuthenticator: authentication.authenticator,
    callerAuthenticator: authentication.authenticator,
    authorizer: () => true,
    admin: {
      authenticator: authentication.adminAuthenticator,
      appVersion: "fixture-1.0.0",
      describeSession: (session) => ({
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        pid: session.registration.pid,
      }),
    },
    idleTimeoutMs: 0,
  });
  const running = await startDaemon(daemon, port);
  let stoppedByAdmin = false;
  const closes: Array<{ code: number; reason: string }> = [];
  const connection = createSessionBrokerConnection({
    ...createConnectionOptions(createSocket),
    url: endpoint,
    producerAuthentication: authentication.producer,
    resolveClose: (event) => {
      closes.push({ code: event.code, reason: event.reason });
      return { reconnect: false };
    },
  });
  try {
    connection.start();
    await waitForRegistration(broker);

    // A caller from a different app revision is refused by the ordinary hello.
    const skewedCaller = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: 99,
      origin,
      ...authentication.caller,
    });
    await skewedCaller
      .request(DEFAULT_SESSION_BROKER_API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      })
      .then(
        () => {
          throw new Error("A skewed caller reached the broker API.");
        },
        (error) => {
          if (!(error instanceof SessionBrokerClientAuthenticationError)) throw error;
        },
      );

    // The same credential reaches the admin scope regardless of app revision.
    const admin = new SessionBrokerAdminClient({
      appId: "dev.example",
      origin,
      ...authentication.caller,
    });
    const status = await admin.status();
    if (
      status.daemonVersion !== 1 ||
      status.appVersion !== "fixture-1.0.0" ||
      status.sessions.length !== 1 ||
      status.sessions[0]?.sessionId !== "runtime-fixture" ||
      status.sessions[0]?.clientDaemonVersion !== 1
    ) {
      throw new Error(`Unexpected admin status: ${JSON.stringify(status)}`);
    }

    // An admin caller session is unknown to the main authenticator and cannot reach the API.
    const adminSessionCaller = new SessionBrokerCallerClient({
      appId: "dev.example",
      appRevision: SESSION_BROKER_ADMIN_SCOPE_VERSION,
      origin,
      challengePath: "/session-admin/challenge",
      proofPath: "/session-admin/proof",
      ...authentication.caller,
    });
    await adminSessionCaller
      .request(DEFAULT_SESSION_BROKER_API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      })
      .then(
        () => {
          throw new Error("An admin caller session reached the broker API.");
        },
        (error) => {
          if (!(error instanceof SessionBrokerClientAuthenticationError)) throw error;
        },
      );

    await admin.stop();
    await running.stopped;
    stoppedByAdmin = true;
    const deadline = Date.now() + 2_000;
    while (closes.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    // Runtimes differ on the reported close code for a server-initiated 1001; the reason is the
    // contract clients key on.
    if (closes[0]?.reason !== SESSION_BROKER_ADMIN_STOP_CLOSE_REASON) {
      throw new Error(`Unexpected producer close: ${JSON.stringify(closes)}`);
    }
    console.log("admin-scope-observed");
  } finally {
    connection.stop();
    // A listener the admin action already retired must not be stopped twice.
    if (!stoppedByAdmin) {
      await running.stop();
      await running.stopped;
    }
  }
}

/** Create a valid producer credential that intentionally leaves its handshake incomplete. */
async function createPendingProducerAuthentication() {
  const pair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const grant: ProducerGrant = {
    kind: "producer",
    appId: "dev.example",
    principalId: "runtime-fixture",
    keyId: "runtime-fixture-key",
    grantId: "runtime-fixture-grant",
    algorithm: SESSION_BROKER_SIGNATURE_ALGORITHM,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revocationId: "runtime-fixture-revocation",
    mayDelegate: false,
    operations: ["register"],
  };
  return {
    appId: grant.appId,
    appRevision: 1,
    credential: { grant, privateKey: pair.privateKey },
    daemon: { keyId: "runtime-fixture-daemon", publicKey: pair.publicKey },
  };
}

/** Create the smallest valid app payload for the real Hunk client startup path. */
function createHunkClientPayload(): {
  registration: HunkSessionRegistration;
  snapshot: HunkSessionSnapshot;
} {
  const timestamp = new Date(0).toISOString();
  return {
    registration: {
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "runtime-fixture",
      pid: process.pid,
      cwd: process.cwd(),
      launchedAt: timestamp,
      info: {
        inputKind: "diff",
        title: "runtime fixture",
        sourceLabel: "runtime fixture",
        files: [],
      },
    },
    snapshot: {
      updatedAt: timestamp,
      state: {
        selectedHunkIndex: 0,
        showAgentNotes: false,
        liveCommentCount: 0,
        liveComments: [],
      },
    },
  };
}

/** Leave the production Hunk client waiting on its automatic startup retry. */
async function runPendingClientStartupRetry() {
  const previousHost = process.env.HUNK_MCP_HOST;
  const previousUnsafeRemote = process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
  const previousConsoleError = console.error;
  delete process.env.HUNK_MCP_DISABLE;
  process.env.HUNK_MCP_HOST = "fixture.invalid";
  delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
  const { registration, snapshot } = createHunkClientPayload();
  const client = new SessionBrokerClient(registration, snapshot, { reconnectDelayMs: 60_000 });
  console.error = () => undefined;
  try {
    await client.start();
    console.log("pending-client-startup-retry");
    // Deliberately do not stop: the real SessionBrokerClient retry must not retain the process.
  } finally {
    console.error = previousConsoleError;
    if (previousHost === undefined) delete process.env.HUNK_MCP_HOST;
    else process.env.HUNK_MCP_HOST = previousHost;
    if (previousUnsafeRemote === undefined) delete process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE;
    else process.env.HUNK_MCP_UNSAFE_ALLOW_REMOTE = previousUnsafeRemote;
  }
}

export type ConnectionFixtureMode =
  | "real"
  | "admin-scope"
  | "pending-handshake"
  | "pending-heartbeat"
  | "pending-reconnect"
  | "pending-client-startup-retry";

export interface RuntimeFixtureAdapter {
  reservePort(): Promise<number>;
  createSocket(url: string): SessionBrokerSocketLike;
  startDaemon(daemon: SessionBrokerDaemon, port: number): Promise<RunningDaemon>;
}

/** Exercise connection timers and Hunk startup work in a standalone runtime process. */
export async function runConnectionFixture(
  mode: ConnectionFixtureMode,
  adapter: RuntimeFixtureAdapter,
) {
  if (mode === "real") {
    await runSignedConnection(adapter);
    return;
  }

  if (mode === "admin-scope") {
    await runAdminScope(adapter);
    return;
  }

  if (mode === "pending-client-startup-retry") {
    await runPendingClientStartupRetry();
    return;
  }

  if (!(["pending-handshake", "pending-heartbeat", "pending-reconnect"] as const).includes(mode)) {
    throw new TypeError(`Unknown connection fixture mode: ${String(mode)}`);
  }

  const socket = new FixtureSocket();
  const options = createConnectionOptions(() => socket);
  const connection = createSessionBrokerConnection(
    mode === "pending-handshake"
      ? {
          ...options,
          producerAuthentication: await createPendingProducerAuthentication(),
        }
      : options,
  );
  connection.start();
  socket.open();
  if (mode === "pending-reconnect") socket.close(1006, "retry");
  console.log(mode);
  // Deliberately do not stop: each production maintenance timer must let the process exit.
}
