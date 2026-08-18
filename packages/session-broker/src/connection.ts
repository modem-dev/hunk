import {
  createReconnectScheduler,
  type ReconnectScheduler,
  type SessionClientMessage,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
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
  private readonly reconnect: ReconnectScheduler;
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
    // Timing is the shared scheduler's; this connection only decides when to ask for a
    // retry and what one does (`docs/browser-review-seam-audit.md`, C5).
    this.reconnect = createReconnectScheduler({
      delayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      onDue: () => this.connect(),
    });
  }

  start() {
    if (this.stopped || this.socket) {
      return;
    }

    this.connect();
  }

  stop() {
    this.stopped = true;
    this.reconnect.stop();

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
    // Re-register instead of sending only a snapshot because selectors like cwd, repoRoot, and the
    // session id itself live in the registration envelope. Send before committing local state so
    // a throwing socket keeps the previous registration and snapshot coherent.
    this.send({
      type: "register",
      registration,
      snapshot,
    });
    this.registration = registration;
    this.snapshot = snapshot;
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
      // Always register again on a fresh socket so the broker can replace any stale connection for
      // the same session id before later snapshots or commands arrive.
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
      // Normalize raw socket errors through onclose so reconnect and warning policy stays in one
      // place instead of splitting behavior across runtime-specific error events.
      socket.close();
    };
  }

  private scheduleReconnect(delayMs?: number) {
    if (!this.stopped) {
      this.reconnect.schedule(delayMs);
    }
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
      // Sessions may connect before the host app has finished wiring its command bridge. Queue
      // broker commands so startup races do not drop user-triggered actions.
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

    // Snapshot the queue up front so commands dispatched while we replay are handled in a later
    // pass and the original broker ordering stays intact.
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
