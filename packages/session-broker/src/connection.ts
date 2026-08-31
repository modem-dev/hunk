import {
  BrokerCapacityError,
  BrokerProtocolError,
  ReservationGroup,
  ResourceBudget,
  parseExactBrokerRecord,
  resolveSessionBrokerLimits,
  utf8ByteLength,
  type BudgetReservation,
  type SessionBrokerLimitOptions,
  type SessionBrokerLimits,
  type SessionClientMessage,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
} from "@hunk/session-broker-core";
import type { SessionBrokerProtocolParsers } from "./protocolParsers";
import { parseSessionBrokerJsonText } from "./protocolParsers";
import {
  answerSessionBrokerHelloChallenge,
  createSessionBrokerHelloRequest,
  verifyProducerHelloAck,
  type PendingSessionBrokerHello,
  type SessionBrokerClientCredential,
  type SessionBrokerDaemonVerifier,
} from "./clientAuthentication";
import type {
  SessionBrokerProducerHelloAck,
  SessionBrokerHelloChallenge,
  SessionBrokerHelloChallengeRequest,
} from "./authentication";
import type { ProducerGrant } from "@hunk/session-broker-core";
import type {
  SessionBrokerConnectionCloseDirective,
  SessionBrokerSocketCloseEvent,
  SessionBrokerSocketLike,
} from "./types";

const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_SOCKET_OPEN_STATE = 1;
const PRODUCER_COMMAND_OVERHEAD_BYTES = 128;

interface QueuedProducerCommand<Socket, Message> {
  socket: Socket;
  message: Message;
  reservation: BudgetReservation;
}

/** Measure one JSON-safe command value without relying on UTF-16 string length. */
function commandValueBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new BrokerProtocolError("invalid-app-payload");
  return utf8ByteLength(serialized);
}

/** Parse one exact handshake wrapper before its payload reaches the authentication parser. */
function exactHelloEnvelope(value: unknown, type: string, payloadKey: "challenge" | "ack") {
  const record = parseExactBrokerRecord(value, ["type", payloadKey] as const, [] as const);
  if (record.type !== type) throw new BrokerProtocolError("invalid-discriminant");
  return record;
}

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
  producerAuthentication?: {
    readonly appId: string;
    readonly appRevision: number;
    readonly credential: SessionBrokerClientCredential<ProducerGrant>;
    readonly daemon: SessionBrokerDaemonVerifier;
  };
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  openState?: number;
  resolveClose?: (event: SessionBrokerSocketCloseEvent) => SessionBrokerConnectionCloseDirective;
  /** Prepare application-owned discovery before one reconnect attempt opens a new socket. */
  prepareReconnect?: () => Promise<void>;
  onConnected?: () => void;
  onWarning?: (message: string) => void;
  limits?: SessionBrokerLimitOptions["limits"];
  unsafeLimits?: SessionBrokerLimitOptions["unsafeLimits"];
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
  private activeSocket: Socket | null = null;
  private bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null;
  readonly limits: Readonly<SessionBrokerLimits>;

  private queuedMessages: Array<QueuedProducerCommand<Socket, ServerMessage>> = [];
  private executingMessages = new Set<QueuedProducerCommand<Socket, ServerMessage>>();
  private readonly queuedCommandCountBudget: ResourceBudget;
  private readonly queuedCommandByteBudget: ResourceBudget;
  private draining = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private registration: SessionRegistration<Info>;
  private snapshot: SessionSnapshot<State>;
  private readonly handshakeTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  private readonly producerHellos = new WeakMap<
    Socket,
    {
      request: SessionBrokerHelloChallengeRequest;
      pending?: PendingSessionBrokerHello<ProducerGrant> | null;
    }
  >();

  constructor(
    private readonly options: SessionBrokerConnectionOptions<
      Info,
      State,
      Socket,
      ServerMessage,
      Result
    >,
  ) {
    this.limits = resolveSessionBrokerLimits({
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.unsafeLimits ? { unsafeLimits: options.unsafeLimits } : {}),
    });
    this.bridge = options.bridge ?? null;
    this.registration = options.registration;
    this.snapshot = options.snapshot;
    this.queuedCommandCountBudget = new ResourceBudget(
      this.limits.maxPreBridgeCommands,
      "maxPreBridgeCommands",
      "queue-full",
    );
    this.queuedCommandByteBudget = new ResourceBudget(
      this.limits.maxQueuedCommandBytes,
      "maxQueuedCommandBytes",
      "queue-full",
    );
  }

  start() {
    if (this.stopped || this.socket) {
      return;
    }

    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const entry of this.queuedMessages.splice(0)) entry.reservation.release();
    for (const entry of this.executingMessages) entry.reservation.release();
    this.executingMessages.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();
    if (this.socket) {
      const handshakeTimer = this.handshakeTimers.get(this.socket);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      this.handshakeTimers.delete(this.socket);
      this.socket.close();
    }
    this.socket = null;
    this.activeSocket = null;
  }

  getRegistration() {
    return this.registration;
  }

  setBridge(bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null) {
    this.bridge = bridge;
    void this.flushQueuedMessages();
  }

  replaceSession(registration: SessionRegistration<Info>, snapshot: SessionSnapshot<State>) {
    if (
      this.options.producerAuthentication &&
      registration.sessionId !== this.registration.sessionId
    ) {
      throw new BrokerProtocolError("invalid-app-payload");
    }
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
    if (this.options.producerAuthentication) {
      const timer = setTimeout(() => {
        socket.close(1008, "Session broker authentication timed out.");
      }, this.limits.maxHandshakeDurationMs);
      timer.unref?.();
      this.handshakeTimers.set(socket, timer);
    }

    socket.onopen = () => {
      if (this.options.producerAuthentication) {
        const authentication = this.options.producerAuthentication;
        const request = createSessionBrokerHelloRequest({
          ...authentication,
          endpoint: this.options.url,
        });
        this.producerHellos.set(socket, { request });
        socket.send(JSON.stringify({ type: "hello-init", hello: request }));
        return;
      }
      this.activateSocket(socket);
    };

    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      if (typeof event.data !== "string") {
        socket.close(1003, "Session broker accepts text messages only.");
        return;
      }
      if (utf8ByteLength(event.data) > this.limits.maxWsMessageBytes) {
        socket.close(1009, "Message exceeds the session broker size limit.");
        return;
      }
      if (this.options.producerAuthentication && this.activeSocket !== socket) {
        void this.handleProducerHello(socket, event.data);
        return;
      }
      let parsed: ServerMessage;
      try {
        const raw = parseSessionBrokerJsonText(event.data) as { input?: unknown };
        if (commandValueBytes(raw?.input) > this.limits.maxCommandInputBytes) {
          throw new BrokerCapacityError("capacity-exceeded", "maxCommandInputBytes");
        }
        parsed = this.options.protocolParsers.parseServerMessage(raw);
        if (commandValueBytes(parsed.input) > this.limits.maxCommandInputBytes) {
          throw new BrokerCapacityError("capacity-exceeded", "maxCommandInputBytes");
        }
      } catch {
        // Never invoke the app bridge after a malformed or mismatched command contract. Closing
        // prevents this producer from retaining daemon assumptions that were not actually parsed.
        socket.close(1008, "Malformed session broker command.");
        return;
      }

      void this.handleServerMessage(socket, parsed);
    };

    socket.onclose = (event) => {
      const wasAuthenticated = this.activeSocket === socket;
      const handshakeTimer = this.handshakeTimers.get(socket);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      this.handshakeTimers.delete(socket);
      if (this.socket === socket) {
        this.socket = null;
        this.activeSocket = null;
        this.stopHeartbeat();
      }

      this.queuedMessages = this.queuedMessages.filter((queued) => {
        if (queued.socket !== socket) return true;
        queued.reservation.release();
        return false;
      });
      // Executing bridge work retains its reservation until its promise settles. A disconnect
      // prevents its response from migrating but does not make the retained input or work vanish.
      if (this.stopped) {
        return;
      }

      const directive = this.options.resolveClose?.({
        code: event.code,
        reason: event.reason,
        authenticated: wasAuthenticated,
      }) ?? { reconnect: true };
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

  private activateSocket(socket: Socket) {
    if (this.socket !== socket || this.activeSocket === socket) return;
    this.activeSocket = socket;
    const handshakeTimer = this.handshakeTimers.get(socket);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    this.handshakeTimers.delete(socket);
    this.startHeartbeat();
    this.options.onConnected?.();
    this.sendToSocket(socket, {
      type: "register",
      registration: this.registration,
      snapshot: this.snapshot,
    });
    void this.flushQueuedMessages(socket);
  }

  /** Verify the daemon challenge and acknowledgement before registration leaves this process. */
  private async handleProducerHello(socket: Socket, message: unknown) {
    try {
      if (typeof message === "string" && utf8ByteLength(message) > this.limits.maxWsMessageBytes) {
        socket.close(1009, "Session broker authentication message exceeded its limit.");
        return;
      }
      const value = parseSessionBrokerJsonText(message);
      const authentication = this.options.producerAuthentication!;
      const hello = this.producerHellos.get(socket);
      if (!hello) throw new Error();
      if (hello.pending === undefined) {
        const envelope = exactHelloEnvelope(value, "hello-challenge", "challenge");
        hello.pending = null;
        const pending = await answerSessionBrokerHelloChallenge(
          { ...authentication, endpoint: this.options.url },
          hello.request,
          envelope.challenge as SessionBrokerHelloChallenge,
        );
        if (
          this.socket !== socket ||
          socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
        ) {
          return;
        }
        hello.pending = pending;
        socket.send(JSON.stringify({ type: "hello-proof", proof: pending.proof }));
        return;
      }
      if (!hello.pending) throw new Error();
      const envelope = exactHelloEnvelope(value, "hello-ack", "ack");
      await verifyProducerHelloAck(hello.pending, envelope.ack as SessionBrokerProducerHelloAck);
      this.activateSocket(socket);
    } catch {
      socket.close(1008, "Session broker authentication failed.");
    }
  }

  private scheduleReconnect(delayMs = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) {
    if (this.reconnectTimer || this.stopped) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.prepareAndReconnect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** Run app discovery once per retry while retaining this connection's aggregate budgets. */
  private async prepareAndReconnect() {
    try {
      await this.options.prepareReconnect?.();
    } catch (error) {
      if (this.stopped) return;
      this.options.onWarning?.(
        error instanceof Error ? error.message : "Session broker reconnect preparation failed.",
      );
      this.scheduleReconnect();
      return;
    }
    if (!this.stopped) this.connect();
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
    if (!this.activeSocket) {
      return;
    }

    this.sendToSocket(this.activeSocket, message);
  }

  /** Send a response only through the still-active socket that received its command. */
  private sendToSocket(socket: Socket, message: SessionClientMessage<Info, State, Result>) {
    if (
      this.socket !== socket ||
      this.activeSocket !== socket ||
      socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
    ) {
      return;
    }

    socket.send(JSON.stringify(message));
  }

  private async handleServerMessage(socket: Socket, message: ServerMessage) {
    const reservations = new ReservationGroup();
    try {
      reservations.add(this.queuedCommandCountBudget.reserve());
      reservations.add(
        this.queuedCommandByteBudget.reserve(
          commandValueBytes(message) + PRODUCER_COMMAND_OVERHEAD_BYTES,
        ),
      );
    } catch {
      reservations.release();
      try {
        this.sendToSocket(socket, {
          type: "command-result",
          requestId: message.requestId,
          ok: false,
          error: "queue-full",
        });
      } catch {
        socket.close(1013, "Session broker queue pressure exceeded.");
      }
      return;
    }

    // Every admitted command, including one executing in a hung bridge, retains its reservation.
    this.queuedMessages.push({ socket, message, reservation: reservations });
    if (this.bridge) await this.flushQueuedMessages(socket);
  }

  private async flushQueuedMessages(socket = this.socket) {
    if (!this.bridge || !socket || this.draining) return;
    this.draining = true;
    try {
      // Take one command at a time so newly received work joins the same FIFO and a disconnect can
      // prevent every command that has not started from executing on a replacement transport.
      for (;;) {
        if (!this.bridge) return;
        const index = this.queuedMessages.findIndex((entry) => entry.socket === socket);
        if (index < 0) return;
        const [entry] = this.queuedMessages.splice(index, 1);
        if (!entry) return;
        if (
          this.socket !== entry.socket ||
          entry.socket.readyState !== (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE)
        ) {
          entry.reservation.release();
          return;
        }
        this.executingMessages.add(entry);
        try {
          await this.executeServerMessage(entry.socket, entry.message);
        } finally {
          this.executingMessages.delete(entry);
          entry.reservation.release();
        }
      }
    } finally {
      this.draining = false;
      if (
        this.bridge &&
        this.socket &&
        this.queuedMessages.some((entry) => entry.socket === this.socket)
      ) {
        void this.flushQueuedMessages(this.socket);
      }
    }
  }

  /** Execute one already-admitted command without re-entering the producer FIFO. */
  private async executeServerMessage(socket: Socket, message: ServerMessage) {
    const bridge = this.bridge;
    if (!bridge) return;
    try {
      const result = await bridge.dispatchCommand(message);
      if (commandValueBytes(result) > this.limits.maxCommandResultBytes) {
        throw new BrokerProtocolError("invalid-app-payload");
      }
      const parsedResult = this.options.protocolParsers.parseCommandResult(
        message.command,
        message.commandVersion ?? 1,
        result,
      );
      if (commandValueBytes(parsedResult) > this.limits.maxCommandResultBytes) {
        throw new BrokerProtocolError("invalid-app-payload");
      }
      this.sendToSocket(socket, {
        type: "command-result",
        requestId: message.requestId,
        ok: true,
        result: parsedResult,
      });
    } catch (error) {
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
