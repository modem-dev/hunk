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

interface ScheduledStartupRetry {
  handle: ReturnType<typeof setTimeout>;
}

type StartupLifecycleState =
  | { status: "idle" }
  | {
      status: "attempting";
      promise: Promise<void>;
      retry: ScheduledStartupRetry | null;
    }
  | { status: "waiting"; retry: ScheduledStartupRetry }
  | { status: "stopped" };

/** Reject an unhandled startup lifecycle state at compile time. */
function assertNeverStartupState(_state: never): never {
  throw new Error("Unhandled startup lifecycle state.");
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
  private startupState: StartupLifecycleState = { status: "idle" };
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
    if (process.env.HUNK_MCP_DISABLE === "1") {
      return;
    }

    const state = this.startupState;
    switch (state.status) {
      case "idle":
        return this.beginStartupAttempt();
      case "attempting":
        return state.promise;
      case "waiting":
        return this.beginStartupAttempt(state.retry);
      case "stopped":
        return;
      default:
        return assertNeverStartupState(state);
    }
  }

  stop() {
    const state = this.startupState;
    switch (state.status) {
      case "idle":
        break;
      case "attempting":
        if (state.retry) clearTimeout(state.retry.handle);
        break;
      case "waiting":
        clearTimeout(state.retry.handle);
        break;
      case "stopped":
        break;
      default:
        assertNeverStartupState(state);
    }

    this.startupState = { status: "stopped" };
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
    if (this.startupState.status === "stopped" || this.connection) {
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
    try {
      connection.start();
    } catch (error) {
      try {
        connection.stop();
      } catch {
        // Preserve the synchronous startup failure even when best-effort cleanup also fails.
      }
      if (this.connection === connection) {
        this.connection = null;
      }
      throw error;
    }
  }

  /** Begin one startup attempt while preserving any automatic retry already in flight. */
  private beginStartupAttempt(retry?: ScheduledStartupRetry) {
    let promise: Promise<void>;
    promise = this.ensureDaemonAndConnect()
      .catch((error) => this.handleStartupFailure(promise, error))
      .finally(() => this.handleStartupSettlement(promise));
    this.startupState = { status: "attempting", promise, retry: retry ?? null };
    return promise;
  }

  /** Warn for the current failed attempt and retain or schedule exactly one retry. */
  private handleStartupFailure(promise: Promise<void>, error: unknown) {
    const state = this.startupState;
    switch (state.status) {
      case "attempting":
        if (state.promise !== promise) return;
        if (!state.retry) {
          const retry = this.createStartupRetry();
          // Publish retry ownership before the warning side effect so a reentrant stop clears the
          // exact handle and cannot be overwritten when the callback returns.
          this.startupState = { status: "attempting", promise, retry };
        }
        this.warnUnavailable(error);
        return;
      case "idle":
      case "waiting":
      case "stopped":
        return;
      default:
        assertNeverStartupState(state);
    }
  }

  /** Move the current settled attempt to idle or back to its retained retry wait. */
  private handleStartupSettlement(promise: Promise<void>) {
    const state = this.startupState;
    switch (state.status) {
      case "attempting":
        if (state.promise === promise) {
          this.startupState = state.retry
            ? { status: "waiting", retry: state.retry }
            : { status: "idle" };
        }
        return;
      case "idle":
      case "waiting":
      case "stopped":
        return;
      default:
        assertNeverStartupState(state);
    }
  }

  /** Schedule one automatic startup retry and preserve its original deadline and identity. */
  private createStartupRetry(delayMs = this.timing.reconnectDelayMs ?? RECONNECT_DELAY_MS) {
    let retry: ScheduledStartupRetry;
    const handle = setTimeout(() => this.handleStartupRetryDeadline(retry), delayMs);
    retry = { handle };
    handle.unref?.();
    return retry;
  }

  /** Consume only the retry whose deadline fired, then start or join the current attempt. */
  private handleStartupRetryDeadline(retry: ScheduledStartupRetry) {
    const state = this.startupState;
    switch (state.status) {
      case "waiting":
        if (state.retry !== retry) return;
        this.startupState = { status: "idle" };
        this.start();
        return;
      case "attempting":
        if (state.retry !== retry) return;
        this.startupState = { status: "attempting", promise: state.promise, retry: null };
        return;
      case "idle":
      case "stopped":
        return;
      default:
        assertNeverStartupState(state);
    }
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
