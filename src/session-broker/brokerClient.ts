import type {
  SessionClientMessage,
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

interface SessionAppBridge<
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  dispatchCommand: (message: ServerMessage) => Promise<Result>;
}

/** Keep one running app session registered with the local session broker daemon. */
export class SessionBrokerClient<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  private websocket: WebSocket | null = null;
  private bridge: SessionAppBridge<ServerMessage, Result> | null = null;
  private queuedMessages: ServerMessage[] = [];
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
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

    this.stopHeartbeat();
    this.websocket?.close();
    this.websocket = null;
  }

  getRegistration() {
    return this.registration;
  }

  replaceSession(registration: SessionRegistration<Info>, snapshot: SessionSnapshot<State>) {
    this.registration = registration;
    this.snapshot = snapshot;
    this.send({
      type: "register",
      registration,
      snapshot,
    });
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
    void this.flushQueuedMessages();
  }

  updateSnapshot(snapshot: SessionSnapshot<State>) {
    this.snapshot = snapshot;
    this.send({
      type: "snapshot",
      sessionId: this.registration.sessionId,
      snapshot,
    });
  }

  private connect(config: ResolvedSessionBrokerConfig) {
    if (this.stopped || this.websocket) {
      return;
    }

    const websocket = new WebSocket(`${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`);
    this.websocket = websocket;

    websocket.onopen = () => {
      this.lastConnectionWarning = null;
      this.startHeartbeat();
      this.send({
        type: "register",
        registration: this.registration,
        snapshot: this.snapshot,
      });
      void this.flushQueuedMessages();
    };

    websocket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }

      void this.handleServerMessage(parsed);
    };

    websocket.onclose = (event) => {
      if (this.websocket === websocket) {
        this.websocket = null;
      }

      this.stopHeartbeat();
      if (this.stopped) {
        return;
      }

      if (this.isIncompatibleSessionClose(event)) {
        this.warnUnavailable(INCOMPATIBLE_SESSION_CLOSE_MESSAGE);
        return;
      }

      this.scheduleReconnect();
    };

    websocket.onerror = () => {
      websocket.close();
    };
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

  private startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: "heartbeat",
        sessionId: this.registration.sessionId,
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private send(message: SessionClientMessage<Info, State, Result>) {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify(message));
  }

  private async handleServerMessage(message: ServerMessage) {
    if (!this.bridge) {
      this.queuedMessages.push(message);
      return;
    }

    try {
      const result = await this.bridge.dispatchCommand(message);
      this.send({
        type: "command-result",
        requestId: message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.send({
        type: "command-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown session error.",
      });
    }
  }

  private async flushQueuedMessages() {
    if (!this.bridge || this.queuedMessages.length === 0) {
      return;
    }

    const queued = [...this.queuedMessages];
    this.queuedMessages = [];

    for (const message of queued) {
      await this.handleServerMessage(message);
    }
  }

  /** Return whether the daemon explicitly rejected this session as incompatible after an upgrade. */
  private isIncompatibleSessionClose(event: CloseEvent) {
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
