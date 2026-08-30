import {
  createSessionBrokerConnection,
  type SessionBrokerConnection as GenericSessionBrokerConnection,
  type SessionBrokerConnectionBridge,
  type SessionBrokerSocketLike,
} from "@hunk/session-broker";
import type { SessionRegistration, SessionSnapshot } from "@hunk/session-broker-core";
import {
  SESSION_BROKER_SOCKET_PATH,
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "./brokerConfig";
import {
  ensureSessionBrokerAvailable,
  isSessionBrokerHealthy,
  readSessionBrokerLaunchFingerprint,
} from "./brokerLauncher";
import { hunkSessionProtocolParsers } from "./protocolParsers";
import {
  loadOrCreateHunkSessionBrokerCredentials,
  type HunkSessionBrokerCredentials,
} from "./credentials";
import { HUNK_SESSION_BROKER_APP_ID, HUNK_SESSION_BROKER_APP_REVISION } from "./appContract";
import { HUNK_DAEMON_UPGRADE_WAIT_MESSAGE } from "../client/capabilities";
import type {
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
} from "../types";

const DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const INCOMPATIBLE_SESSION_CLOSE_CODE = 1008;
const QUIESCENT_REFUSAL_REASONS = new Set([
  "Session broker authentication required; upgrade Hunk.",
  "Malformed session broker protocol.",
]);

type SessionAppBridge = SessionBrokerConnectionBridge<
  HunkSessionServerMessage,
  HunkSessionCommandResult
>;

interface SessionBrokerClientTiming {
  daemonStartupTimeoutMs?: number;
  reconnectDelayMs?: number;
}

/** Identify only known compatibility refusals before producer activation. */
export function isQuiescentUpgradeRefusal(event: {
  code: number;
  reason: string;
  authenticated?: boolean;
}) {
  return (
    event.authenticated === false &&
    event.code === INCOMPATIBLE_SESSION_CLOSE_CODE &&
    QUIESCENT_REFUSAL_REASONS.has(event.reason)
  );
}

/** The concrete broker client bound to Hunk's session contracts. */
export type HunkSessionBrokerClient = SessionBrokerClient;

/** Keep one running Hunk session registered with the local session broker daemon. */
export class SessionBrokerClient {
  private connection: GenericSessionBrokerConnection<
    HunkSessionInfo,
    HunkSessionState,
    SessionBrokerSocketLike,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  > | null = null;
  private bridge: SessionAppBridge | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private startupPromise: Promise<void> | null = null;
  private lastConnectionWarning: string | null = null;
  private credentials: HunkSessionBrokerCredentials | null = null;
  private waitingForIncumbentExit = false;
  private incumbentLaunchFingerprint: string | null = null;

  constructor(
    private registration: SessionRegistration<HunkSessionInfo>,
    private snapshot: SessionSnapshot<HunkSessionState>,
    private timing: SessionBrokerClientTiming = {},
  ) {}

  start() {
    if (this.stopped || process.env.HUNK_MCP_DISABLE === "1") {
      return;
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = this.ensureDaemonAndConnect()
      .catch((error) => {
        if (this.stopped) {
          return;
        }

        this.warnUnavailable(error);
        this.scheduleReconnect();
      })
      .finally(() => {
        this.startupPromise = null;
      });

    return this.startupPromise;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connection?.stop();
    this.connection = null;
  }

  getRegistration() {
    return this.registration;
  }

  replaceSession(
    registration: SessionRegistration<HunkSessionInfo>,
    snapshot: SessionSnapshot<HunkSessionState>,
  ) {
    // Let the connection validate/send first. If it throws, the client keeps
    // serving the previous registration and snapshot as one coherent pair.
    this.connection?.replaceSession(registration, snapshot);
    this.registration = registration;
    this.snapshot = snapshot;
  }

  private resolveConfig() {
    return resolveSessionBrokerConfig();
  }

  private async ensureDaemonAndConnect() {
    const config = this.resolveConfig();
    await this.ensureDaemonAvailable(config);
    this.credentials ??= await loadOrCreateHunkSessionBrokerCredentials();
    this.connect(config);
  }

  private async ensureDaemonAvailable(config: ResolvedSessionBrokerConfig) {
    await ensureSessionBrokerAvailable({
      config,
      timeoutMs: this.timing.daemonStartupTimeoutMs ?? DAEMON_STARTUP_TIMEOUT_MS,
    });

    // Minimal health proves only liveness. Compatibility and identity are established by the
    // signed websocket hello; an unverifiable incumbent is never signalled or replaced by PID.
  }

  setBridge(bridge: SessionAppBridge | null) {
    this.bridge = bridge;
    this.connection?.setBridge(bridge);
  }

  updateSnapshot(snapshot: SessionSnapshot<HunkSessionState>) {
    this.snapshot = snapshot;
    this.connection?.updateSnapshot(snapshot);
  }

  private connect(config: ResolvedSessionBrokerConfig) {
    if (this.stopped || this.connection) {
      return;
    }

    if (!this.credentials) return;
    const connection = createSessionBrokerConnection<
      HunkSessionInfo,
      HunkSessionState,
      SessionBrokerSocketLike,
      HunkSessionServerMessage,
      HunkSessionCommandResult
    >({
      url: `${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`,
      createSocket: (url) => new WebSocket(url) as unknown as SessionBrokerSocketLike,
      registration: this.registration,
      snapshot: this.snapshot,
      bridge: this.bridge,
      protocolParsers: hunkSessionProtocolParsers,
      producerAuthentication: {
        appId: HUNK_SESSION_BROKER_APP_ID,
        appRevision: HUNK_SESSION_BROKER_APP_REVISION,
        credential: this.credentials.producer,
        daemon: {
          keyId: this.credentials.daemonIdentity.keyId,
          publicKey: this.credentials.daemonPublicKey,
        },
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      reconnectDelayMs: this.timing.reconnectDelayMs ?? RECONNECT_DELAY_MS,
      prepareReconnect: async () => {
        if (this.waitingForIncumbentExit) {
          const healthy = await isSessionBrokerHealthy(config);
          if (healthy) {
            const currentFingerprint = readSessionBrokerLaunchFingerprint(config);
            // Owner-private metadata is only a generation-change hint. The signed hello remains the
            // sole compatibility and identity authority, and unchanged/malformed metadata causes
            // health-only polling so skewed waiters cannot keep the incumbent active.
            if (currentFingerprint === this.incumbentLaunchFingerprint) {
              throw new Error(HUNK_DAEMON_UPGRADE_WAIT_MESSAGE);
            }
          }
          this.waitingForIncumbentExit = false;
        }
        await this.ensureDaemonAvailable(config);
      },
      resolveClose: (event) => {
        const preAuthenticationRefusal = isQuiescentUpgradeRefusal(event);
        if (preAuthenticationRefusal) {
          this.waitingForIncumbentExit = true;
          this.incumbentLaunchFingerprint = readSessionBrokerLaunchFingerprint(config);
        }
        return {
          reconnect: true,
          ...(preAuthenticationRefusal ? { warning: HUNK_DAEMON_UPGRADE_WAIT_MESSAGE } : {}),
        };
      },
      onConnected: () => {
        this.waitingForIncumbentExit = false;
        this.incumbentLaunchFingerprint = null;
        this.lastConnectionWarning = null;
      },
      onWarning: (message) => this.warnUnavailable(message),
    });

    this.connection = connection;
    connection.start();
  }

  private scheduleReconnect(delayMs = this.timing.reconnectDelayMs ?? RECONNECT_DELAY_MS) {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private warnUnavailable(error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown session broker connection error.";
    if (message === this.lastConnectionWarning) {
      return;
    }

    this.lastConnectionWarning = message;
    console.error(`[session:broker] ${message}`);
  }
}
