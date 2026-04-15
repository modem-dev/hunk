import {
  createSessionBrokerConnection,
  type SessionBrokerConnection as GenericSessionBrokerConnection,
  type SessionBrokerConnectionBridge,
  type SessionBrokerSocketLike,
} from "@hunk/session-broker";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
} from "@hunk/session-broker-core";
import {
  SESSION_BROKER_SOCKET_PATH,
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "./brokerConfig";
import {
  ensureSessionBrokerAvailable,
  readSessionBrokerHealth,
  waitForSessionBrokerShutdown,
} from "./brokerLauncher";
import {
  readHunkSessionDaemonCapabilities,
  reportHunkDaemonUpgradeRestart,
} from "../session/capabilities";

const DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const INCOMPATIBLE_SESSION_CLOSE_CODE = 1008;
const INCOMPATIBLE_SESSION_CLOSE_REASON_PREFIX = "Incompatible session ";
const INCOMPATIBLE_SESSION_CLOSE_MESSAGE =
  "This window is too old for the refreshed session broker daemon. Restart the window to reconnect.";

type SessionAppBridge<
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> = SessionBrokerConnectionBridge<ServerMessage, Result>;

/** Keep one running app session registered with the local session broker daemon. */
export class SessionBrokerClient<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  private connection: GenericSessionBrokerConnection<
    Info,
    State,
    SessionBrokerSocketLike,
    ServerMessage,
    Result
  > | null = null;
  private bridge: SessionAppBridge<ServerMessage, Result> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private startupPromise: Promise<void> | null = null;
  private lastConnectionWarning: string | null = null;

  constructor(
    private registration: SessionRegistration<Info>,
    private snapshot: SessionSnapshot<State>,
  ) {}

  start() {
    if (process.env.HUNK_MCP_DISABLE === "1") {
      return;
    }

    if (this.startupPromise) {
      return;
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

  replaceSession(registration: SessionRegistration<Info>, snapshot: SessionSnapshot<State>) {
    this.registration = registration;
    this.snapshot = snapshot;
    this.connection?.replaceSession(registration, snapshot);
  }

  private resolveConfig() {
    return resolveSessionBrokerConfig();
  }

  private async ensureDaemonAndConnect() {
    const config = this.resolveConfig();
    await this.ensureDaemonAvailable(config);
    this.connect(config);
  }

  private async ensureDaemonAvailable(config: ResolvedSessionBrokerConfig) {
    await ensureSessionBrokerAvailable({
      config,
      timeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    });

    const capabilities = await readHunkSessionDaemonCapabilities(config);
    if (!capabilities) {
      await this.restartIncompatibleDaemon(config);
      await ensureSessionBrokerAvailable({
        config,
        timeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
      });

      if (!(await readHunkSessionDaemonCapabilities(config))) {
        throw new Error(
          "The running session broker daemon is incompatible with this build. " +
            "Restart the app so it can launch a fresh daemon from the current source tree.",
        );
      }
    }

    this.lastConnectionWarning = null;
  }

  private async restartIncompatibleDaemon(config: ResolvedSessionBrokerConfig) {
    reportHunkDaemonUpgradeRestart();
    const health = await readSessionBrokerHealth(config);
    const pid = health?.pid;
    if (pid === process.pid) {
      throw new Error(
        "The running session broker daemon is incompatible with this build. " +
          "Restart the app so it can launch a fresh daemon from the current source tree.",
      );
    }

    // If the stale daemon already disappeared on its own, let the normal startup path launch a
    // fresh one instead of turning that race into a manual restart error.
    if (!pid) {
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        throw error;
      }
    }

    const shutDown = await waitForSessionBrokerShutdown({
      config,
      timeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    });
    if (!shutDown) {
      throw new Error(
        "Stopped waiting for the old session broker daemon to exit after it was found incompatible.",
      );
    }
  }

  setBridge(bridge: SessionAppBridge<ServerMessage, Result> | null) {
    this.bridge = bridge;
    this.connection?.setBridge(bridge);
  }

  updateSnapshot(snapshot: SessionSnapshot<State>) {
    this.snapshot = snapshot;
    this.connection?.updateSnapshot(snapshot);
  }

  private connect(config: ResolvedSessionBrokerConfig) {
    if (this.stopped || this.connection) {
      return;
    }

    this.connection = createSessionBrokerConnection<
      Info,
      State,
      SessionBrokerSocketLike,
      ServerMessage,
      Result
    >({
      url: `${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`,
      createSocket: (url) => new WebSocket(url) as unknown as SessionBrokerSocketLike,
      registration: this.registration,
      snapshot: this.snapshot,
      bridge: this.bridge,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      reconnectDelayMs: RECONNECT_DELAY_MS,
      resolveClose: (event) =>
        this.isIncompatibleSessionClose(event)
          ? { reconnect: false, warning: INCOMPATIBLE_SESSION_CLOSE_MESSAGE }
          : { reconnect: true },
      onWarning: (message) => this.warnUnavailable(message),
    });

    this.connection.start();
  }

  private scheduleReconnect(delayMs = RECONNECT_DELAY_MS) {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** Return whether the daemon explicitly rejected this session as incompatible after an upgrade. */
  private isIncompatibleSessionClose(event: { code: number; reason: string }) {
    return (
      event.code === INCOMPATIBLE_SESSION_CLOSE_CODE &&
      event.reason.startsWith(INCOMPATIBLE_SESSION_CLOSE_REASON_PREFIX)
    );
  }

  private warnUnavailable(error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown session broker connection error.";
    if (message === this.lastConnectionWarning) {
      return;
    }

    this.lastConnectionWarning = message;
    console.error(`[session:broker] ${message}`);
  }
}
