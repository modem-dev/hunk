import type { AppliedCommentResult, HunkSessionRegistration, HunkSessionSnapshot, SessionClientMessage, SessionServerMessage } from "./types";
import { HUNK_SESSION_SOCKET_PATH, resolveHunkMcpConfig } from "./config";

export interface HunkAppBridge {
  applyComment: (message: Extract<SessionServerMessage, { command: "comment" }>) => Promise<AppliedCommentResult>;
}

/** Keep one running Hunk TUI session registered with the local MCP daemon. */
export class HunkHostClient {
  private websocket: WebSocket | null = null;
  private bridge: HunkAppBridge | null = null;
  private queuedMessages: SessionServerMessage[] = [];
  private reconnectTimer: Timer | null = null;
  private stopped = false;
  private readonly config = resolveHunkMcpConfig();

  constructor(
    private readonly registration: HunkSessionRegistration,
    private snapshot: HunkSessionSnapshot,
  ) {}

  start() {
    if (process.env.HUNK_MCP_DISABLE === "1") {
      return;
    }

    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.websocket?.close();
    this.websocket = null;
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

  private connect() {
    if (this.stopped || this.websocket) {
      return;
    }

    const websocket = new WebSocket(`${this.config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`);
    this.websocket = websocket;

    websocket.onopen = () => {
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
      this.websocket = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };

    websocket.onerror = () => {
      websocket.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3_000);
    this.reconnectTimer.unref?.();
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
      const result = await this.bridge.applyComment(message);
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
}
