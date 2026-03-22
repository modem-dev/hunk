import type {
  AppliedCommentResult,
  ClearedCommentsResult,
  HunkSessionRegistration,
  HunkSessionSnapshot,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SessionClientMessage,
  SessionCommandResult,
  SessionServerMessage,
} from "./types";
import {
  HUNK_SESSION_SOCKET_PATH,
  resolveHunkMcpConfig,
  type ResolvedHunkMcpConfig,
} from "./config";
import {
  isHunkDaemonHealthy,
  isLoopbackPortReachable,
  launchHunkDaemon,
  waitForHunkDaemonHealth,
} from "./daemonLauncher";

const DAEMON_LAUNCH_COOLDOWN_MS = 5_000;
const DAEMON_STARTUP_TIMEOUT_MS = 3_000;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

interface HunkAppBridge {
  applyComment: (
    message: Extract<SessionServerMessage, { command: "comment" }>,
  ) => Promise<AppliedCommentResult>;
  navigateToHunk: (
    message: Extract<SessionServerMessage, { command: "navigate_to_hunk" }>,
  ) => Promise<NavigatedSelectionResult>;
  removeComment: (
    message: Extract<SessionServerMessage, { command: "remove_comment" }>,
  ) => Promise<RemovedCommentResult>;
  clearComments: (
    message: Extract<SessionServerMessage, { command: "clear_comments" }>,
  ) => Promise<ClearedCommentsResult>;
}

/** Keep one running Hunk TUI session registered with the local MCP daemon. */
export class HunkHostClient {
  private websocket: WebSocket | null = null;
  private bridge: HunkAppBridge | null = null;
  private queuedMessages: SessionServerMessage[] = [];
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private stopped = false;
  private startupPromise: Promise<void> | null = null;
  private lastDaemonLaunchStartedAt = 0;
  private lastConnectionWarning: string | null = null;

  constructor(
    private readonly registration: HunkSessionRegistration,
    private snapshot: HunkSessionSnapshot,
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

  private resolveConfig() {
    return resolveHunkMcpConfig();
  }

  private async ensureDaemonAndConnect() {
    const config = this.resolveConfig();
    await this.ensureDaemonAvailable(config);
    this.connect(config);
  }

  private async ensureDaemonAvailable(config: ResolvedHunkMcpConfig) {
    if (await isHunkDaemonHealthy(config)) {
      this.lastConnectionWarning = null;
      return;
    }

    const shouldLaunch = Date.now() - this.lastDaemonLaunchStartedAt >= DAEMON_LAUNCH_COOLDOWN_MS;
    if (shouldLaunch) {
      this.lastDaemonLaunchStartedAt = Date.now();
      launchHunkDaemon();
    }

    const ready = await waitForHunkDaemonHealth({
      config,
      timeoutMs: shouldLaunch ? DAEMON_STARTUP_TIMEOUT_MS : 1_500,
    });

    if (ready) {
      this.lastConnectionWarning = null;
      return;
    }

    const portReachable = await isLoopbackPortReachable(config);
    if (portReachable) {
      throw new Error(
        `Hunk MCP port ${config.host}:${config.port} is already in use by another process. ` +
          `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
      );
    }

    throw new Error(
      `Timed out waiting for the Hunk MCP daemon on ${config.host}:${config.port}. ` +
        `Hunk will retry in the background.`,
    );
  }

  setBridge(bridge: HunkAppBridge | null) {
    this.bridge = bridge;
    void this.flushQueuedMessages();
  }

  updateSnapshot(snapshot: HunkSessionSnapshot) {
    this.snapshot = snapshot;
    this.send({
      type: "snapshot",
      sessionId: this.registration.sessionId,
      snapshot,
    });
  }

  private connect(config: ResolvedHunkMcpConfig) {
    if (this.stopped || this.websocket) {
      return;
    }

    const websocket = new WebSocket(`${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`);
    this.websocket = websocket;

    websocket.onopen = () => {
      this.lastDaemonLaunchStartedAt = 0;
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

      let parsed: SessionServerMessage;
      try {
        parsed = JSON.parse(event.data) as SessionServerMessage;
      } catch {
        return;
      }

      void this.handleServerMessage(parsed);
    };

    websocket.onclose = () => {
      if (this.websocket === websocket) {
        this.websocket = null;
      }

      this.stopHeartbeat();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
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

  private send(message: SessionClientMessage) {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify(message));
  }

  private async handleServerMessage(message: SessionServerMessage) {
    if (!this.bridge) {
      this.queuedMessages.push(message);
      return;
    }

    try {
      const result = await this.dispatchCommand(message);
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
        error: error instanceof Error ? error.message : "Unknown Hunk session error.",
      });
    }
  }

  private dispatchCommand(message: SessionServerMessage): Promise<SessionCommandResult> {
    if (!this.bridge) {
      throw new Error("Hunk MCP bridge is not connected.");
    }

    switch (message.command) {
      case "comment":
        return this.bridge.applyComment(message);
      case "navigate_to_hunk":
        return this.bridge.navigateToHunk(message);
      case "remove_comment":
        return this.bridge.removeComment(message);
      case "clear_comments":
        return this.bridge.clearComments(message);
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

  private warnUnavailable(error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown Hunk MCP connection error.";
    if (message === this.lastConnectionWarning) {
      return;
    }

    this.lastConnectionWarning = message;
    console.error(`[hunk:mcp] ${message}`);
  }
}
