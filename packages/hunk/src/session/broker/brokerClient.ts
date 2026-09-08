import {
  createNativeSessionBrokerLifecycleClock,
  createSessionBrokerConnection,
  type SessionBrokerConnection as GenericSessionBrokerConnection,
  type SessionBrokerConnectionBridge,
  type SessionBrokerConnectionGeneration,
  type SessionBrokerLifecycleClock,
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

export interface SessionBrokerClientOptions {
  daemonStartupTimeoutMs?: number;
  reconnectDelayMs?: number;
  lifecycleClock?: SessionBrokerLifecycleClock;
  /** Observe a terminal connection lifecycle defect through the broker's fixed message. */
  onDefect?: (message: string) => void;
}

interface ScheduledStartupRetry {
  dispose: () => void;
}

interface StartupAttempt {
  readonly id: symbol;
}

interface ClientConnectionGeneration {
  readonly id: symbol;
}

type StartupLifecycleState =
  | { status: "idle" }
  | {
      status: "attempting";
      attempt: StartupAttempt;
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
  private connectionGeneration: ClientConnectionGeneration | null = null;
  private lastConnectionWarning: string | null = null;
  private credentials: HunkSessionBrokerCredentials | null = null;
  private waitingForIncumbentExit = false;
  private incumbentLaunchFingerprint: string | null = null;
  private readonly lifecycleClock: SessionBrokerLifecycleClock;

  constructor(
    private registration: SessionRegistration<HunkSessionInfo>,
    private snapshot: SessionSnapshot<HunkSessionState>,
    private timing: SessionBrokerClientOptions = {},
  ) {
    this.lifecycleClock = timing.lifecycleClock ?? createNativeSessionBrokerLifecycleClock();
  }

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
        state.retry?.dispose();
        break;
      case "waiting":
        state.retry.dispose();
        break;
      case "stopped":
        break;
      default:
        assertNeverStartupState(state);
    }

    this.startupState = { status: "stopped" };
    this.connectionGeneration = null;
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

  /** Return whether one startup attempt still owns commits for this live client. */
  private isStartupAttemptCurrent(attempt: StartupAttempt) {
    const state = this.startupState;
    switch (state.status) {
      case "attempting":
        return state.attempt === attempt;
      case "idle":
      case "waiting":
      case "stopped":
        return false;
      default:
        return assertNeverStartupState(state);
    }
  }

  /** Load credentials as foreign work so tests can hold its settlement deterministically. */
  private loadCredentials() {
    return loadOrCreateHunkSessionBrokerCredentials();
  }

  private async ensureDaemonAndConnect(attempt: StartupAttempt) {
    const isCommitAuthorized = () => this.isStartupAttemptCurrent(attempt);
    const config = this.resolveConfig();
    await this.ensureDaemonAvailable(config, isCommitAuthorized);
    if (!isCommitAuthorized()) return;
    if (!this.credentials) {
      const credentials = await this.loadCredentials();
      if (!isCommitAuthorized()) return;
      this.credentials = credentials;
    }
    if (!isCommitAuthorized()) return;
    this.connect(config);
  }

  private async ensureDaemonAvailable(
    config: ResolvedSessionBrokerConfig,
    isCommitAuthorized: () => boolean = () => true,
  ) {
    await ensureSessionBrokerAvailable({
      config,
      timeoutMs: this.timing.daemonStartupTimeoutMs ?? DAEMON_STARTUP_TIMEOUT_MS,
      lifecycleClock: this.lifecycleClock,
      isCommitAuthorized,
    });
    if (!isCommitAuthorized()) return;

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
    if (this.startupState.status === "stopped" || this.connection) return;
    if (!this.credentials) return;

    const clientGeneration: ClientConnectionGeneration = {
      id: Symbol("broker-connection"),
    };
    let connection!: GenericSessionBrokerConnection<
      HunkSessionInfo,
      HunkSessionState,
      SessionBrokerSocketLike,
      HunkSessionServerMessage,
      HunkSessionCommandResult
    >;
    const isConnectionCurrent = (brokerGeneration?: SessionBrokerConnectionGeneration) =>
      this.startupState.status !== "stopped" &&
      this.connectionGeneration === clientGeneration &&
      this.connection === connection &&
      (!brokerGeneration || connection.isGenerationCurrent(brokerGeneration));

    connection = createSessionBrokerConnection<
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
      lifecycleClock: this.lifecycleClock,
      prepareReconnect: async (brokerGeneration) => {
        const isCommitAuthorized = () => isConnectionCurrent(brokerGeneration);
        if (!isCommitAuthorized()) return;
        if (this.waitingForIncumbentExit) {
          const healthy = await isSessionBrokerHealthy(config);
          if (!isCommitAuthorized()) return;
          if (healthy) {
            const currentFingerprint = readSessionBrokerLaunchFingerprint(config);
            if (!isCommitAuthorized()) return;
            // Owner-private metadata is only a generation-change hint. The signed hello remains the
            // sole compatibility and identity authority, and unchanged/malformed metadata causes
            // health-only polling so skewed waiters cannot keep the incumbent active.
            if (currentFingerprint === this.incumbentLaunchFingerprint) {
              throw new Error(HUNK_DAEMON_UPGRADE_WAIT_MESSAGE);
            }
          }
          if (!isCommitAuthorized()) return;
          this.waitingForIncumbentExit = false;
        }
        await this.ensureDaemonAvailable(config, isCommitAuthorized);
        if (!isCommitAuthorized()) return;
      },
      resolveClose: (event, brokerGeneration) => {
        if (!isConnectionCurrent(brokerGeneration)) return { reconnect: false };
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
      onConnected: (brokerGeneration) => {
        if (!isConnectionCurrent(brokerGeneration)) return;
        this.waitingForIncumbentExit = false;
        this.incumbentLaunchFingerprint = null;
        this.lastConnectionWarning = null;
      },
      onWarning: (message, brokerGeneration) => {
        if (isConnectionCurrent(brokerGeneration)) this.warnUnavailable(message);
      },
      onDefect: this.timing.onDefect,
    });

    this.connectionGeneration = clientGeneration;
    this.connection = connection;
    try {
      connection.start();
    } catch (error) {
      try {
        connection.stop();
      } catch {
        // Preserve the synchronous startup failure even when best-effort cleanup also fails.
      }
      if (this.connection === connection && this.connectionGeneration === clientGeneration) {
        this.connection = null;
        this.connectionGeneration = null;
      }
      throw error;
    }
  }

  /** Begin one startup attempt while preserving any automatic retry already in flight. */
  private beginStartupAttempt(retry?: ScheduledStartupRetry) {
    const attempt: StartupAttempt = { id: Symbol("broker-startup") };
    let resolveWork!: () => void;
    let rejectWork!: (error: unknown) => void;
    const work = new Promise<void>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    let promise: Promise<void>;
    promise = work
      .catch((error) => this.handleStartupFailure(promise, attempt, error))
      .finally(() => this.handleStartupSettlement(promise, attempt));
    // Publish the complete authoritative state before foreign startup work can synchronously stop
    // or otherwise invalidate this attempt.
    this.startupState = { status: "attempting", attempt, promise, retry: retry ?? null };
    try {
      void Promise.resolve(this.ensureDaemonAndConnect(attempt)).then(resolveWork, rejectWork);
    } catch (error) {
      rejectWork(error);
    }
    return promise;
  }

  /** Warn for the current failed attempt and retain or schedule exactly one retry. */
  private handleStartupFailure(promise: Promise<void>, attempt: StartupAttempt, error: unknown) {
    const state = this.startupState;
    switch (state.status) {
      case "attempting":
        if (state.promise !== promise || state.attempt !== attempt) return;
        if (!state.retry) {
          const retry = this.createStartupRetry();
          // Publish retry ownership before the warning side effect so a reentrant stop clears the
          // exact handle and cannot be overwritten when the callback returns.
          this.startupState = { status: "attempting", attempt, promise, retry };
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
  private handleStartupSettlement(promise: Promise<void>, attempt: StartupAttempt) {
    const state = this.startupState;
    switch (state.status) {
      case "attempting":
        if (state.promise === promise && state.attempt === attempt) {
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
    const dispose = this.lifecycleClock.schedule(
      () => this.handleStartupRetryDeadline(retry),
      delayMs,
    );
    retry = { dispose };
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
        this.startupState = {
          status: "attempting",
          attempt: state.attempt,
          promise: state.promise,
          retry: null,
        };
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
