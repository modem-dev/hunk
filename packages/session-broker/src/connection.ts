import {
  BrokerProtocolError,
  type SessionClientMessage,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import type { SessionBrokerProtocolParsers } from "./protocolParsers";
import { parseSessionBrokerJsonText } from "./protocolParsers";
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
  protocolParsers: SessionBrokerProtocolParsers<Info, State, ServerMessage, Result>;
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
  private queuedMessages: Array<{ socket: Socket; message: ServerMessage }> = [];
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
      // Register on every fresh socket after the prior close retired its broker-side ownership.
      this.sendToSocket(socket, {
        type: "register",
        registration: this.registration,
        snapshot: this.snapshot,
      });
      void this.flushQueuedMessages(socket);
    };

    socket.onmessage = (event) => {
      let parsed: ServerMessage;
      try {
        parsed = this.options.protocolParsers.parseServerMessage(
          parseSessionBrokerJsonText(event.data),
        );
      } catch {
        // Never invoke the app bridge after a malformed or mismatched command contract. Closing
        // prevents this producer from retaining daemon assumptions that were not actually parsed.
        socket.close(1008, "Malformed session broker command.");
        return;
      }

      void this.handleServerMessage(socket, parsed);
    };

    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
        this.stopHeartbeat();
      }

      this.queuedMessages = this.queuedMessages.filter((queued) => queued.socket !== socket);
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
    if (!this.socket) {
      return;
    }

    this.sendToSocket(this.socket, message);
  }

  /** Send a response only through the still-active socket that received its command. */
  private sendToSocket(socket: Socket, message: SessionClientMessage<Info, State, Result>) {
    if (
      this.socket !== socket ||
      socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
    ) {
      return;
    }

    socket.send(JSON.stringify(message));
  }

  private async handleServerMessage(socket: Socket, message: ServerMessage) {
    if (!this.bridge) {
      // Sessions may connect before the host app has finished wiring its command bridge. Bind each
      // queued command to its source so a reconnect cannot inherit work from a disconnected socket.
      this.queuedMessages.push({ socket, message });
      return;
    }

    try {
      const result = await this.bridge.dispatchCommand(message);
      const parsedResult = this.options.protocolParsers.parseCommandResult(
        message.command,
        message.commandVersion ?? 1,
        result,
      );
      this.sendToSocket(socket, {
        type: "command-result",
        requestId: message.requestId,
        ok: true,
        result: parsedResult,
      });
    } catch (error) {
      // Parser failures invalidate the selected command contract and cannot be represented as an
      // app command rejection. Close without reflecting callback details.
      if (error instanceof BrokerProtocolError) {
        socket.close(1008, "Malformed session broker command result.");
        return;
      }
      this.sendToSocket(socket, {
        type: "command-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown broker connection error.",
      });
    }
  }

  private async flushQueuedMessages(socket = this.socket) {
    if (!this.bridge || !socket || this.queuedMessages.length === 0) {
      return;
    }

    // Snapshot only this transport's queue so commands cannot cross a disconnect. Commands received
    // while replay runs stay in the queue for a later pass and preserve their original ordering.
    const queued = this.queuedMessages.filter((entry) => entry.socket === socket);
    this.queuedMessages = this.queuedMessages.filter((entry) => entry.socket !== socket);

    for (const entry of queued) {
      if (
        this.socket !== entry.socket ||
        entry.socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
      ) {
        break;
      }

      await this.handleServerMessage(entry.socket, entry.message);
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
