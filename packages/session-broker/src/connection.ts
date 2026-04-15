import type {
  SessionClientMessage,
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
} from "@hunk/session-broker-core";
import type {
  SessionBrokerConnectionCloseDirective,
  SessionBrokerSocketCloseEvent,
  SessionBrokerSocketLike,
} from "./types";

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_SOCKET_OPEN_STATE = 1;

export interface SessionBrokerConnectionBridge<
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  dispatchCommand: (message: ServerMessage) => Promise<Result>;
}

export interface SessionBrokerConnectionOptions<
  Info = unknown,
  State = unknown,
  Socket extends SessionBrokerSocketLike = SessionBrokerSocketLike,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  url: string;
  createSocket: (url: string) => Socket;
  registration: SessionRegistration<Info>;
  snapshot: SessionSnapshot<State>;
  bridge?: SessionBrokerConnectionBridge<ServerMessage, Result> | null;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  openState?: number;
  resolveClose?: (event: SessionBrokerSocketCloseEvent) => SessionBrokerConnectionCloseDirective;
  onWarning?: (message: string) => void;
}

/**
 * Keep one live app session connected to a broker websocket while staying agnostic about which
 * runtime or websocket implementation created the underlying socket.
 */
export class SessionBrokerConnection<
  Info = unknown,
  State = unknown,
  Socket extends SessionBrokerSocketLike = SessionBrokerSocketLike,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
> {
  private socket: Socket | null = null;
  private bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null;
  private queuedMessages: ServerMessage[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private registration: SessionRegistration<Info>;
  private snapshot: SessionSnapshot<State>;

  constructor(
    private readonly options: SessionBrokerConnectionOptions<
      Info,
      State,
      Socket,
      ServerMessage,
      Result
    >,
  ) {
    this.bridge = options.bridge ?? null;
    this.registration = options.registration;
    this.snapshot = options.snapshot;
  }

  start() {
    if (this.stopped || this.socket) {
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

    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  getRegistration() {
    return this.registration;
  }

  setBridge(bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null) {
    this.bridge = bridge;
    void this.flushQueuedMessages();
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

  updateSnapshot(snapshot: SessionSnapshot<State>) {
    this.snapshot = snapshot;
    this.send({
      type: "snapshot",
      sessionId: this.registration.sessionId,
      snapshot,
    });
  }

  private connect() {
    if (this.stopped || this.socket) {
      return;
    }

    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      this.startHeartbeat();
      this.send({
        type: "register",
        registration: this.registration,
        snapshot: this.snapshot,
      });
      void this.flushQueuedMessages();
    };

    socket.onmessage = (event) => {
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

    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.stopHeartbeat();
      if (this.stopped) {
        return;
      }

      const directive = this.options.resolveClose?.(event) ?? { reconnect: true };
      if (directive.warning) {
        this.options.onWarning?.(directive.warning);
      }

      if (directive.reconnect !== false) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(delayMs = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
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
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

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
    if (
      !this.socket ||
      this.socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
    ) {
      return;
    }

    this.socket.send(JSON.stringify(message));
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
        error: error instanceof Error ? error.message : "Unknown broker connection error.",
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

/** Create one runtime-neutral session connection around a browser-like websocket factory. */
export function createSessionBrokerConnection<
  Info = unknown,
  State = unknown,
  Socket extends SessionBrokerSocketLike = SessionBrokerSocketLike,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  Result = unknown,
>(options: SessionBrokerConnectionOptions<Info, State, Socket, ServerMessage, Result>) {
  return new SessionBrokerConnection(options);
}
