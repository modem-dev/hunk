import {
  SESSION_BROKER_REGISTRATION_VERSION,
  SESSION_BROKER_SIGNATURE_ALGORITHM,
  SessionBroker,
  SessionBrokerAuthenticator,
  createSessionBrokerConnection,
  createSessionBrokerDaemon,
  createSessionBrokerProtocolParsers,
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
