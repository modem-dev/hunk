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
  createNativeSessionBrokerLifecycleClock,
  type SessionBrokerLifecycleClock,
} from "./lifecycleClock";
import {
  answerSessionBrokerHelloChallenge,
  createSessionBrokerHelloRequest,
  verifyProducerHelloAck,
  type PendingSessionBrokerHello,
  type SessionBrokerClientCredential,
  type SessionBrokerDaemonVerifier,
} from "./clientAuthentication";
import type { SessionBrokerCrypto } from "./crypto";
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

export const SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE =
  "Session broker lifecycle failed unexpectedly.";

/** Identifies the exact socket generation that owns one connection callback. */
export interface SessionBrokerConnectionGeneration {
  readonly id: number;
}

interface ConnectionGeneration<Socket> {
  readonly token: SessionBrokerConnectionGeneration;
  readonly socket: Socket;
  status: "connecting" | "active" | "closing" | "close-failed" | "closed";
  authenticated: boolean;
}

interface ScheduledReconnect<Socket> {
  readonly generation: ConnectionGeneration<Socket>;
  readonly dispose: () => void;
}

interface PendingSessionReplacement<Info, State> {
  readonly registration: SessionRegistration<Info>;
  readonly snapshot: SessionSnapshot<State>;
  published: boolean;
}

interface QueuedProducerCommand<Socket, Message> {
  generation: ConnectionGeneration<Socket>;
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
  /** Create a fresh socket object for each generation; property handlers cannot safely be reused. */
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
    readonly crypto?: SessionBrokerCrypto;
  };
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  /** Supply lifecycle timing for authentication, heartbeats, and reconnect attempts. */
  lifecycleClock?: SessionBrokerLifecycleClock;
  openState?: number;
  resolveClose?: (
    event: SessionBrokerSocketCloseEvent,
    generation: SessionBrokerConnectionGeneration,
  ) => SessionBrokerConnectionCloseDirective;
  /** Prepare application-owned discovery before one reconnect attempt opens a new socket. */
  prepareReconnect?: (generation: SessionBrokerConnectionGeneration) => Promise<void>;
  onConnected?: (generation: SessionBrokerConnectionGeneration) => void;
  onWarning?: (message: string, generation: SessionBrokerConnectionGeneration) => void;
  /** Observe one terminal lifecycle defect through a fixed, redacted message. */
  onDefect?: (message: string) => void;
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
  private currentGeneration: ConnectionGeneration<Socket> | null = null;
  private nextGenerationId = 1;
  private constructingSocket = false;
  private readonly adoptedSockets = new WeakSet<Socket>();
  private bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null;
  readonly limits: Readonly<SessionBrokerLimits>;

  private queuedMessages: Array<QueuedProducerCommand<Socket, ServerMessage>> = [];
  private executingMessages = new Set<QueuedProducerCommand<Socket, ServerMessage>>();
  private readonly queuedCommandCountBudget: ResourceBudget;
  private readonly queuedCommandByteBudget: ResourceBudget;
  private draining = false;
  private reconnectTimer: ScheduledReconnect<Socket> | null = null;
  private heartbeatTimer: (() => void) | null = null;
  private stopped = false;
  private lifecycleDefectReported = false;
  private registration: SessionRegistration<Info>;
  private snapshot: SessionSnapshot<State>;
  private pendingSessionReplacement: PendingSessionReplacement<Info, State> | null = null;
  private readonly lifecycleClock: SessionBrokerLifecycleClock;
  private readonly handshakeTimers = new Map<ConnectionGeneration<Socket>, () => void>();
  private readonly producerHellos = new WeakMap<
    ConnectionGeneration<Socket>,
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
    this.lifecycleClock = options.lifecycleClock ?? createNativeSessionBrokerLifecycleClock();
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
    if (this.stopped || this.socket || this.constructingSocket) return;
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const entry of this.queuedMessages.splice(0)) entry.reservation.release();
    // Executing foreign bridge work is not cancellable. Its reservation remains owned until the
    // promise settles; generation-fenced delivery prevents its response from migrating.
    this.clearReconnectTimer();

    this.stopHeartbeat();
    const generation = this.currentGeneration;
    if (generation) {
      this.disposeHandshake(generation);
      if (generation.status !== "closed") {
        this.closeGeneration(generation);
        if (generation.status === "closing") generation.status = "closed";
      }
    }
    this.socket = null;
    this.currentGeneration = null;
  }

  /** Report whether a callback still belongs to this connection's exact commit generation. */
  isGenerationCurrent(generation: SessionBrokerConnectionGeneration) {
    return !this.stopped && this.currentGeneration?.token === generation;
  }

  getRegistration() {
    return this.registration;
  }

  setBridge(bridge: SessionBrokerConnectionBridge<ServerMessage, Result> | null) {
    this.bridge = bridge;
    this.observeLifecycleWork(this.flushQueuedMessages());
  }

  replaceSession(registration: SessionRegistration<Info>, snapshot: SessionSnapshot<State>) {
    if (
      this.options.producerAuthentication &&
      registration.sessionId !== this.registration.sessionId
    ) {
      throw new BrokerProtocolError("invalid-app-payload");
    }
    if (this.pendingSessionReplacement) {
      throw new BrokerProtocolError("invalid-app-payload");
    }

    const replacement: PendingSessionReplacement<Info, State> = {
      registration,
      snapshot,
      published: false,
    };
    this.pendingSessionReplacement = replacement;
    try {
      // Re-register instead of sending only a snapshot because selectors like cwd, repoRoot, and
      // the session id itself live in the registration envelope. A generation activated
      // reentrantly during serialization also reads this pending pair, keeping broker and local
      // state coherent before the synchronous transaction commits.
      if (
        this.send({
          type: "register",
          registration,
          snapshot,
        })
      ) {
        replacement.published = true;
      }
      this.registration = registration;
      this.snapshot = snapshot;
    } catch (error) {
      if (!replacement.published) throw error;
      // A replacement generation already published this exact candidate. Treat a stale source
      // generation's later send failure as retired work rather than claiming rollback succeeded.
      this.registration = registration;
      this.snapshot = snapshot;
    } finally {
      if (this.pendingSessionReplacement === replacement) {
        this.pendingSessionReplacement = null;
      }
    }
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
    if (this.stopped || this.socket || this.constructingSocket) return;

    // Publish construction ownership before invoking the foreign factory so a reentrant start
    // cannot construct a second socket. Synchronous factory failures remain caller-visible.
    this.constructingSocket = true;
    let socket: Socket;
    try {
      socket = this.options.createSocket(this.options.url);
    } finally {
      this.constructingSocket = false;
    }

    if (this.stopped || this.socket) {
      try {
        socket.close();
      } catch {
        // Terminal/reentrant ownership already won; orphan cleanup is best effort.
      }
      return;
    }
    if (this.adoptedSockets.has(socket)) {
      throw new Error("Session broker socket factory must return a fresh socket.");
    }
    this.adoptedSockets.add(socket);
    this.clearReconnectTimer();
    const generation: ConnectionGeneration<Socket> = {
      token: Object.freeze({ id: this.nextGenerationId++ }),
      socket,
      status: "connecting",
      authenticated: false,
    };
    this.currentGeneration = generation;
    this.socket = socket;
    if (this.options.producerAuthentication) {
      let disposeHandshake: () => void;
      try {
        disposeHandshake = this.lifecycleClock.schedule(() => {
          this.runLifecycleCallback(() => {
            this.closeGeneration(generation, 1008, "Session broker authentication timed out.");
          });
        }, this.limits.maxHandshakeDurationMs);
      } catch {
        // Construction has already committed this socket generation. A scheduling failure is no
        // longer a caller-owned factory failure, so retire it through the bounded defect boundary.
        this.reportLifecycleDefect();
        return;
      }
      if (this.stopped || this.currentGeneration !== generation) {
        try {
          disposeHandshake();
        } catch {
          this.reportLifecycleDefect();
        }
        return;
      }
      this.handshakeTimers.set(generation, disposeHandshake);
    }

    socket.onopen = () => {
      this.runLifecycleCallback(() => {
        if (!this.canAuthenticate(generation)) return;
        if (this.options.producerAuthentication) {
          const authentication = this.options.producerAuthentication;
          const request = createSessionBrokerHelloRequest({
            ...authentication,
            endpoint: this.options.url,
          });
          this.producerHellos.set(generation, { request });
          socket.send(JSON.stringify({ type: "hello-init", hello: request }));
          return;
        }
        this.activateGeneration(generation);
      });
    };

    socket.onmessage = (event) => {
      this.runLifecycleCallback(() => {
        if (!this.canReceive(generation)) return;
        if (typeof event.data !== "string") {
          this.closeGeneration(generation, 1003, "Session broker accepts text messages only.");
          return;
        }
        if (utf8ByteLength(event.data) > this.limits.maxWsMessageBytes) {
          this.closeGeneration(generation, 1009, "Message exceeds the session broker size limit.");
          return;
        }
        if (this.options.producerAuthentication && generation.status !== "active") {
          this.observeLifecycleWork(this.handleProducerHello(generation, event.data));
          return;
        }
        let parsed: ServerMessage;
        try {
          const raw = parseSessionBrokerJsonText(event.data) as {
            input?: unknown;
          };
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
          this.closeGeneration(generation, 1008, "Malformed session broker command.");
          return;
        }

        // App-owned parsers may synchronously stop or replace the connection. Refuse admission after
        // that authority change so the stale input retains no budget or queue ownership.
        if (!this.isGenerationActive(generation)) return;
        this.observeLifecycleWork(this.handleServerMessage(generation, parsed));
      });
    };

    socket.onclose = (event) => {
      this.runLifecycleCallback(() => {
        const wasAuthenticated = generation.authenticated;
        this.disposeHandshake(generation);
        const ownsConnection = this.currentGeneration === generation;
        generation.status = "closed";
        if (ownsConnection) {
          this.socket = null;
          this.stopHeartbeat();
        }

        this.queuedMessages = this.queuedMessages.filter((queued) => {
          if (queued.generation !== generation) return true;
          queued.reservation.release();
          return false;
        });
        // Executing bridge work retains its reservation until its promise settles. A disconnect
        // prevents its response from migrating but does not make the retained input or work vanish.
        if (this.stopped || !ownsConnection || this.currentGeneration !== generation) return;

        const directive = this.options.resolveClose?.(
          {
            code: event.code,
            reason: event.reason,
            authenticated: wasAuthenticated,
          },
          generation.token,
        ) ?? { reconnect: true };
        if (directive.warning && this.isGenerationCurrent(generation.token)) {
          this.observeLifecycleCallbackResult(
            this.options.onWarning?.(directive.warning, generation.token),
          );
        }

        if (directive.reconnect !== false && this.isGenerationCurrent(generation.token)) {
          this.scheduleReconnect(generation);
        }
      });
    };

    socket.onerror = () => {
      this.runLifecycleCallback(() => {
        // Normalize raw socket errors through onclose so reconnect and warning policy stays in one
        // place instead of splitting behavior across runtime-specific error events.
        this.closeGeneration(generation);
      });
    };
  }

  /** Return whether this exact generation can still commit authentication work. */
  private canAuthenticate(generation: ConnectionGeneration<Socket>) {
    return (
      this.currentGeneration === generation &&
      generation.status === "connecting" &&
      generation.socket.readyState === (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE) &&
      !this.stopped
    );
  }

  /** Return whether this exact generation can still receive protocol input. */
  private canReceive(generation: ConnectionGeneration<Socket>) {
    return (
      this.currentGeneration === generation &&
      (generation.status === "connecting" || generation.status === "active") &&
      !this.stopped
    );
  }

  /** Close only the exact current generation and retire its commit authority before close settles. */
  private closeGeneration(
    generation: ConnectionGeneration<Socket>,
    code?: number,
    reason?: string,
  ) {
    if (
      this.currentGeneration !== generation ||
      generation.status === "closing" ||
      generation.status === "closed"
    ) {
      return;
    }
    generation.status = "closing";
    try {
      generation.socket.close(code, reason);
    } catch (error) {
      // A terminal close decision permanently retires protocol authority even when the adapter
      // throws before emitting close. The explicit state still permits a later close attempt.
      if (this.currentGeneration === generation && generation.status === "closing") {
        generation.status = "close-failed";
      }
      throw error;
    }
  }

  /** Dispose and forget only the handshake timer owned by one exact generation. */
  private disposeHandshake(generation: ConnectionGeneration<Socket>) {
    const dispose = this.handshakeTimers.get(generation);
    dispose?.();
    this.handshakeTimers.delete(generation);
  }

  /** Return whether one exact generation remains the active send authority. */
  private isGenerationActive(generation: ConnectionGeneration<Socket>) {
    return (
      this.currentGeneration === generation &&
      generation.status === "active" &&
      generation.socket.readyState === (this.options.openState ?? DEFAULT_SOCKET_OPEN_STATE) &&
      !this.stopped
    );
  }

  private activateGeneration(generation: ConnectionGeneration<Socket>) {
    if (!this.canAuthenticate(generation)) return;
    generation.status = "active";
    generation.authenticated = true;
    this.disposeHandshake(generation);
    this.startHeartbeat(generation);
    this.observeLifecycleCallbackResult(this.options.onConnected?.(generation.token));
    const replacement = this.pendingSessionReplacement;
    const registration = replacement?.registration ?? this.registration;
    const snapshot = replacement?.snapshot ?? this.snapshot;
    if (
      this.sendToGeneration(generation, {
        type: "register",
        registration,
        snapshot,
      }) &&
      replacement &&
      this.pendingSessionReplacement === replacement
    ) {
      replacement.published = true;
    }
    this.observeLifecycleWork(this.flushQueuedMessages(generation));
  }

  /** Verify the daemon challenge and acknowledgement before registration leaves this process. */
  private async handleProducerHello(generation: ConnectionGeneration<Socket>, message: unknown) {
    const socket = generation.socket;
    let sendingProof = false;
    let activating = false;
    try {
      if (typeof message === "string" && utf8ByteLength(message) > this.limits.maxWsMessageBytes) {
        this.closeGeneration(
          generation,
          1009,
          "Session broker authentication message exceeded its limit.",
        );
        return;
      }
      const value = parseSessionBrokerJsonText(message);
      const authentication = this.options.producerAuthentication!;
      const hello = this.producerHellos.get(generation);
      if (!hello) throw new Error();
      if (hello.pending === undefined) {
        const envelope = exactHelloEnvelope(value, "hello-challenge", "challenge");
        hello.pending = null;
        const pending = await answerSessionBrokerHelloChallenge(
          { ...authentication, endpoint: this.options.url },
          hello.request,
          envelope.challenge as SessionBrokerHelloChallenge,
        );
        if (!this.canAuthenticate(generation)) return;
        hello.pending = pending;
        sendingProof = true;
        socket.send(JSON.stringify({ type: "hello-proof", proof: pending.proof }));
        sendingProof = false;
        return;
      }
      if (!hello.pending) throw new Error();
      const envelope = exactHelloEnvelope(value, "hello-ack", "ack");
      await verifyProducerHelloAck(hello.pending, envelope.ack as SessionBrokerProducerHelloAck);
      if (!this.canAuthenticate(generation)) return;
      activating = true;
      this.activateGeneration(generation);
    } catch {
      if (sendingProof || activating) {
        this.reportLifecycleDefect();
        return;
      }
      if (!this.canAuthenticate(generation)) return;
      this.closeGeneration(generation, 1008, "Session broker authentication failed.");
    }
  }

  private scheduleReconnect(
    generation: ConnectionGeneration<Socket>,
    delayMs = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
  ) {
    if (!this.isGenerationCurrent(generation.token)) return;
    if (this.reconnectTimer?.generation === generation) return;
    this.clearReconnectTimer();

    let scheduled!: ScheduledReconnect<Socket>;
    const dispose = this.lifecycleClock.schedule(() => {
      if (this.reconnectTimer !== scheduled) return;
      this.reconnectTimer = null;
      if (!this.isGenerationCurrent(generation.token)) return;
      this.observeLifecycleWork(this.prepareAndReconnect(generation));
    }, delayMs);
    scheduled = { generation, dispose };
    this.reconnectTimer = scheduled;
  }

  /** Dispose only the reconnect timer that currently owns scheduling authority. */
  private clearReconnectTimer() {
    this.reconnectTimer?.dispose();
    this.reconnectTimer = null;
  }

  /** Run app discovery once per retry while retaining this connection's aggregate budgets. */
  private async prepareAndReconnect(generation: ConnectionGeneration<Socket>) {
    try {
      await this.options.prepareReconnect?.(generation.token);
    } catch (error) {
      this.handleReconnectFailure(generation, error);
      return;
    }
    if (!this.isGenerationCurrent(generation.token)) return;
    try {
      this.connect();
    } catch (error) {
      // Explicit public start keeps synchronous factory failures. Once reconnect owns the attempt,
      // a transient factory failure follows the existing warning and retry policy instead.
      this.handleReconnectFailure(generation, error);
    }
  }

  /** Warn and retry only while one failed reconnect generation still owns commit authority. */
  private handleReconnectFailure(generation: ConnectionGeneration<Socket>, error: unknown) {
    if (!this.isGenerationCurrent(generation.token)) return;
    this.observeLifecycleCallbackResult(
      this.options.onWarning?.(
        error instanceof Error ? error.message : "Session broker reconnect preparation failed.",
        generation.token,
      ),
    );
    if (!this.isGenerationCurrent(generation.token)) return;
    this.scheduleReconnect(generation);
  }

  private startHeartbeat(generation: ConnectionGeneration<Socket>) {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = this.lifecycleClock.scheduleInterval(() => {
      this.runLifecycleCallback(() => {
        if (!this.isGenerationActive(generation)) return;
        this.send({
          type: "heartbeat",
          sessionId: this.registration.sessionId,
        });
      });
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer();
    this.heartbeatTimer = null;
  }

  /** Contain one native or timer callback failure at the lifecycle owner. */
  private runLifecycleCallback(callback: () => void) {
    try {
      callback();
    } catch {
      this.reportLifecycleDefect();
    }
  }

  /** Observe fire-and-forget lifecycle work without exposing its rejection. */
  private observeLifecycleWork(work: Promise<unknown>) {
    void work.catch(() => this.reportLifecycleDefect());
  }

  /** Treat a promise returned from a nominally synchronous lifecycle callback as observed work. */
  private observeLifecycleCallbackResult(result: unknown) {
    void Promise.resolve(result).catch(() => this.reportLifecycleDefect());
  }

  /** Retire all lifecycle authority and emit at most one fixed defect notification. */
  private reportLifecycleDefect() {
    if (this.stopped || this.lifecycleDefectReported) return;
    this.lifecycleDefectReported = true;
    this.stopped = true;

    const reconnectTimer = this.reconnectTimer;
    this.reconnectTimer = null;
    try {
      reconnectTimer?.dispose();
    } catch {
      // Defect cleanup is terminal and best effort; observer failures cannot recurse.
    }

    const heartbeatTimer = this.heartbeatTimer;
    this.heartbeatTimer = null;
    try {
      heartbeatTimer?.();
    } catch {
      // Continue retiring the remaining socket and scheduling authority.
    }

    const handshakeTimers = [...this.handshakeTimers.values()];
    this.handshakeTimers.clear();
    for (const dispose of handshakeTimers) {
      try {
        dispose();
      } catch {
        // Continue retiring every handshake timer after one disposer fails.
      }
    }

    for (const entry of this.queuedMessages.splice(0)) {
      try {
        entry.reservation.release();
      } catch {
        // Internal reservation cleanup cannot weaken terminal lifecycle retirement.
      }
    }

    const generation = this.currentGeneration;
    this.currentGeneration = null;
    this.socket = null;
    if (generation) {
      generation.status = "closed";
      try {
        generation.socket.close();
      } catch {
        // Socket cleanup cannot escape or trigger a second defect notification.
      }
    }

    try {
      const observerResult = this.options.onDefect?.(SESSION_BROKER_LIFECYCLE_DEFECT_MESSAGE);
      // TypeScript permits async functions where a void callback is expected. Observe that promise
      // without recursively reporting a defect in the best-effort defect observer itself.
      void Promise.resolve(observerResult).catch(() => undefined);
    } catch {
      // The optional observer is best effort and cannot recursively report its own failure.
    }
  }

  private send(message: SessionClientMessage<Info, State, Result>) {
    const generation = this.currentGeneration;
    if (!generation) return false;
    return this.sendToGeneration(generation, message);
  }

  /** Send a response only through the still-active generation that received its command. */
  private sendToGeneration(
    generation: ConnectionGeneration<Socket>,
    message: SessionClientMessage<Info, State, Result>,
  ) {
    if (!this.isGenerationActive(generation)) return false;
    const serialized = JSON.stringify(message);
    // App-owned values can run `toJSON` while the envelope is serialized. Refuse delivery when that
    // callback retires or replaces the exact generation before the transport write begins.
    if (!this.isGenerationActive(generation)) return false;
    generation.socket.send(serialized);
    return true;
  }

  private async handleServerMessage(
    generation: ConnectionGeneration<Socket>,
    message: ServerMessage,
  ) {
    let messageBytes: number;
    try {
      messageBytes = commandValueBytes(message) + PRODUCER_COMMAND_OVERHEAD_BYTES;
    } catch {
      this.rejectQueuePressure(generation, message.requestId);
      return;
    }

    // JSON serialization is app-influenced and can synchronously retire this generation. Recheck
    // authority before reserving so stale work cannot consume capacity from its replacement.
    if (!this.isGenerationActive(generation)) return;
    const reservations = new ReservationGroup();
    try {
      reservations.add(this.queuedCommandCountBudget.reserve());
      reservations.add(this.queuedCommandByteBudget.reserve(messageBytes));
    } catch {
      reservations.release();
      this.rejectQueuePressure(generation, message.requestId);
      return;
    }

    if (!this.isGenerationActive(generation)) {
      reservations.release();
      return;
    }
    // Every admitted command, including one executing in a hung bridge, retains its reservation.
    this.queuedMessages.push({
      generation,
      message,
      reservation: reservations,
    });
    if (this.bridge) await this.flushQueuedMessages(generation);
  }

  /** Reject one over-budget command without admitting it to the producer queue. */
  private rejectQueuePressure(generation: ConnectionGeneration<Socket>, requestId: string) {
    if (!this.isGenerationActive(generation)) return;
    try {
      this.sendToGeneration(generation, {
        type: "command-result",
        requestId,
        ok: false,
        error: "queue-full",
      });
    } catch {
      this.closeGeneration(generation, 1013, "Session broker queue pressure exceeded.");
    }
  }

  private async flushQueuedMessages(generation = this.currentGeneration) {
    if (!this.bridge || !generation || this.draining) return;
    this.draining = true;
    let failed = false;
    try {
      // Take one command at a time so newly received work joins the same FIFO and a disconnect can
      // prevent every command that has not started from executing on a replacement transport.
      for (;;) {
        if (!this.bridge) return;
        const index = this.queuedMessages.findIndex((entry) => entry.generation === generation);
        if (index < 0) return;
        const [entry] = this.queuedMessages.splice(index, 1);
        if (!entry) return;
        if (!this.isGenerationActive(entry.generation)) {
          entry.reservation.release();
          return;
        }
        this.executingMessages.add(entry);
        try {
          await this.executeServerMessage(entry.generation, entry.message);
        } finally {
          this.executingMessages.delete(entry);
          entry.reservation.release();
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.draining = false;
      if (
        !failed &&
        this.bridge &&
        this.currentGeneration &&
        this.queuedMessages.some((entry) => entry.generation === this.currentGeneration)
      ) {
        this.observeLifecycleWork(this.flushQueuedMessages(this.currentGeneration));
      }
    }
  }

  /** Execute one already-admitted command without re-entering the producer FIFO. */
  private async executeServerMessage(
    generation: ConnectionGeneration<Socket>,
    message: ServerMessage,
  ) {
    const bridge = this.bridge;
    if (!bridge) return;

    let result: Result;
    try {
      result = await bridge.dispatchCommand(message);
    } catch (error) {
      if (!this.isGenerationActive(generation)) return;
      // A bridge rejection is an expected command outcome. Serialization and transport remain
      // outside this catch so their defects cannot be mislabeled or expose the thrown value.
      this.sendToGeneration(generation, {
        type: "command-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown broker connection error.",
      });
      return;
    }

    if (!this.isGenerationActive(generation)) return;
    let parsedResult: Result;
    try {
      if (commandValueBytes(result) > this.limits.maxCommandResultBytes) {
        throw new BrokerProtocolError("invalid-app-payload");
      }
      parsedResult = this.options.protocolParsers.parseCommandResult(
        message.command,
        message.commandVersion ?? 1,
        result,
      );
      if (commandValueBytes(parsedResult) > this.limits.maxCommandResultBytes) {
        throw new BrokerProtocolError("invalid-app-payload");
      }
    } catch {
      if (!this.isGenerationActive(generation)) return;
      this.closeGeneration(generation, 1008, "Malformed session broker command result.");
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify({
        type: "command-result",
        requestId: message.requestId,
        ok: true,
        result: parsedResult,
      } satisfies SessionClientMessage<Info, State, Result>);
    } catch {
      if (!this.isGenerationActive(generation)) return;
      this.closeGeneration(generation, 1008, "Malformed session broker command result.");
      return;
    }
    // App-owned serialization can retire this generation. The transport write itself remains
    // outside every expected-error catch and therefore rejects to the lifecycle defect observer.
    if (!this.isGenerationActive(generation)) return;
    generation.socket.send(serialized);
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
