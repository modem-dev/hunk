import { randomUUID } from "node:crypto";
import { isValidBrokerRevision } from "./auth";
import {
  BrokerCapacityError,
  ReservationGroup,
  ResourceBudget,
  resolveSessionBrokerLimits,
  type BudgetReservation,
  type SessionBrokerLimitOptions,
  type SessionBrokerLimits,
} from "./budgets";
import { utf8ByteLength } from "./limits";
import { BrokerProtocolError, parseBrokerAppPayload } from "./validation";
import { matchesSessionSelector, repoSelectorDistance, type SelectableSession } from "./selectors";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
  SessionTargetInput,
} from "./types";

interface PendingCommand<Result> {
  requestId: string;
  sessionId: string;
  socket: DaemonSessionSocket;
  command: string;
  commandVersion: number;
  serializedMessage: string;
  reservation: BudgetReservation;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
}

interface DaemonSessionSocket {
  send(data: string): unknown;
}

/** Hold one live broker session plus the socket that owns it. */
export interface SessionBrokerEntry<Info = unknown, State = unknown> {
  registration: SessionRegistration<Info>;
  snapshot: SessionSnapshot<State>;
  socket: DaemonSessionSocket;
  connectedAt: string;
  lastSeenAt: string;
}

/** Describe the minimum projected session shape shared by broker selectors and listings. */
export interface SessionBrokerListedSession extends SelectableSession {
  title: string;
  snapshot: {
    updatedAt: string;
  };
}

/**
 * Delegate app-owned parsing and projection to the adapter so the broker core never imports one
 * specific app's registration, snapshot, or review payload modules.
 */
export interface SessionBrokerViewAdapter<
  Info,
  State,
  ListedSession extends SessionBrokerListedSession,
  SelectedContext,
  SessionReview,
  SessionCommentSummary,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  parseRegistration: (value: unknown) => SessionRegistration<Info> | null;
  parseSnapshot: (value: unknown) => SessionSnapshot<State> | null;
  parseCommandInput: (
    command: ServerMessage["command"],
    version: number,
    value: unknown,
  ) => unknown;
  parseCommandResult: (
    command: ServerMessage["command"],
    version: number,
    value: unknown,
  ) => CommandResult | null;
  buildListedSession: (entry: SessionBrokerEntry<Info, State>) => ListedSession;
  buildSelectedContext: (session: ListedSession) => SelectedContext;
  buildSessionReview: (
    entry: SessionBrokerEntry<Info, State>,
    options: { includePatch?: boolean; includeNotes?: boolean },
  ) => SessionReview;
  listComments: (session: ListedSession, filter: { filePath?: string }) => SessionCommentSummary[];
}

export type RegisterSessionResult =
  | "registered"
  | "invalid"
  | "already-connected"
  | "capacity-exceeded"
  | "shutdown";
export type UpdateSnapshotResult = "updated" | "invalid" | "not-owner" | "capacity-exceeded";
export type MarkSessionSeenResult = "seen" | "not-owner";
export type HandleCommandResult = "handled" | "not-found" | "not-owner" | "invalid";

export type SessionTargetSelector = SessionTargetInput;

const RETAINED_SESSION_OVERHEAD_BYTES = 256;
const QUEUED_COMMAND_OVERHEAD_BYTES = 128;

/** Measure one JSON-safe retained value in UTF-8 plus its fixed broker bookkeeping overhead. */
function retainedJsonBytes(value: unknown, overhead: number): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Session broker data is not JSON serializable.");
  }
  if (serialized === undefined)
    throw new TypeError("Session broker data is not JSON serializable.");
  return utf8ByteLength(serialized) + overhead;
}

function describeSessionChoices<ListedSession extends SessionBrokerListedSession>(
  sessions: ListedSession[],
) {
  return sessions.map((session) => `${session.sessionId} (${session.title})`).join(", ");
}

/** Resolve which live session one external command should target. */
export function resolveSessionTarget<ListedSession extends SessionBrokerListedSession>(
  sessions: ListedSession[],
  selector: SessionTargetSelector,
) {
  if (selector.sessionId) {
    const matched = sessions.find((session) => matchesSessionSelector(session, selector));
    if (!matched) {
      throw new Error(`No active session matches sessionId ${selector.sessionId}.`);
    }

    return matched;
  }

  const sessionPath = selector.sessionPath;
  if (sessionPath) {
    const matches = sessions.filter((session) => matchesSessionSelector(session, selector));
    if (matches.length === 0) {
      throw new Error(`No active session matches session path ${sessionPath}.`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple active sessions match session path ${sessionPath}; specify sessionId instead. ` +
          `Matches: ${describeSessionChoices(matches)}.`,
      );
    }

    return matches[0]!;
  }

  if (selector.repoRoot) {
    const candidates = sessions
      .map((session) => ({
        session,
        distance: repoSelectorDistance(session, selector.repoRoot!, selector.repoBoundary),
      }))
      .filter(
        (entry): entry is { session: ListedSession; distance: number } => entry.distance !== null,
      );
    if (candidates.length === 0) {
      throw new Error(`No active session matches repoRoot ${selector.repoRoot}.`);
    }

    const nearestDistance = Math.min(...candidates.map((entry) => entry.distance));
    const matches = candidates
      .filter((entry) => entry.distance === nearestDistance)
      .map((entry) => entry.session);
    if (matches.length > 1) {
      throw new Error(
        `Multiple active sessions match repoRoot ${selector.repoRoot}; specify sessionId instead. ` +
          `Matches: ${describeSessionChoices(matches)}.`,
      );
    }

    return matches[0]!;
  }

  if (sessions.length === 1) {
    return sessions[0]!;
  }

  if (sessions.length === 0) {
    throw new Error(
      "No active sessions are registered with the broker. Open the app and wait for it to connect.",
    );
  }

  throw new Error(
    `Multiple active sessions are registered; specify sessionId, sessionPath, or repoRoot. ` +
      `Sessions: ${describeSessionChoices(sessions)}.`,
  );
}

/** Track registered sessions and route broker commands onto the correct live app instance. */
export class SessionBrokerState<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
  ListedSession extends SessionBrokerListedSession = SessionBrokerListedSession,
  SelectedContext = unknown,
  SessionReview = unknown,
  SessionCommentSummary = unknown,
> {
  readonly limits: Readonly<SessionBrokerLimits>;

  private sessions = new Map<string, SessionBrokerEntry<Info, State>>();
  private sessionIdsBySocket = new Map<DaemonSessionSocket, string>();
  private pendingCommands = new Map<string, PendingCommand<CommandResult>>();
  private commandQueues = new Map<string, string[]>();
  private retainedReservations = new Map<string, BudgetReservation>();
  private sessionReservations = new Map<string, BudgetReservation>();
  private readonly sessionBudget: ResourceBudget;
  private readonly commandBudget: ResourceBudget;
  private readonly queuedCommandByteBudget: ResourceBudget;
  private readonly retainedByteBudget: ResourceBudget;
  private lastPruneAt: number | null = null;
  private shutdownError: Error | null = null;

  constructor(
    private view: SessionBrokerViewAdapter<
      Info,
      State,
      ListedSession,
      SelectedContext,
      SessionReview,
      SessionCommentSummary,
      ServerMessage,
      CommandResult
    >,
    limitOptions: SessionBrokerLimitOptions = {},
  ) {
    this.limits = resolveSessionBrokerLimits(limitOptions);
    this.sessionBudget = new ResourceBudget(this.limits.maxSessions, "maxSessions");
    this.commandBudget = new ResourceBudget(
      this.limits.maxCommandsTotal,
      "maxCommandsTotal",
      "queue-full",
    );
    this.queuedCommandByteBudget = new ResourceBudget(
      this.limits.maxQueuedCommandBytes,
      "maxQueuedCommandBytes",
      "queue-full",
    );
    this.retainedByteBudget = new ResourceBudget(this.limits.maxRetainedBytes, "maxRetainedBytes");
  }

  listSessions(): ListedSession[] {
    return [...this.sessions.values()]
      .map((entry) => this.view.buildListedSession(entry))
      .sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt));
  }

  getSession(selector: SessionTargetSelector) {
    return resolveSessionTarget(this.listSessions(), selector);
  }

  /** Return the live session's loaded review model, with raw patch text included only on demand. */
  getSessionReview(
    selector: SessionTargetSelector,
    options: { includePatch?: boolean; includeNotes?: boolean } = {},
  ): SessionReview {
    return this.view.buildSessionReview(this.getSessionEntry(selector), options);
  }

  getSelectedContext(selector: SessionTargetSelector): SelectedContext {
    return this.view.buildSelectedContext(this.getSession(selector));
  }

  listComments(selector: SessionTargetSelector, filter: { filePath?: string } = {}) {
    return this.view.listComments(this.getSession(selector), filter);
  }

  getSessionCount() {
    return this.sessions.size;
  }

  getPendingCommandCount() {
    return this.pendingCommands.size;
  }

  registerSession(
    socket: DaemonSessionSocket,
    registrationInput: unknown,
    snapshotInput: unknown,
    options: { replaceOwner?: boolean } = {},
  ): RegisterSessionResult {
    if (this.shutdownError) return "shutdown";

    let registration: SessionRegistration<Info> | null;
    let snapshot: SessionSnapshot<State> | null;
    try {
      registration = this.view.parseRegistration(registrationInput);
      snapshot = this.view.parseSnapshot(snapshotInput);
    } catch {
      return "invalid";
    }
    if (!registration || !snapshot) return "invalid";

    let retainedBytes: number;
    try {
      // Measure the values the parser actually retains so transforming parsers cannot expand past
      // either the per-session or aggregate ceiling.
      retainedBytes = retainedJsonBytes(
        { registration, snapshot },
        RETAINED_SESSION_OVERHEAD_BYTES,
      );
    } catch {
      return "invalid";
    }
    if (retainedBytes > this.limits.maxRetainedSessionBytes) return "capacity-exceeded";

    const existing = this.sessions.get(registration.sessionId);
    if (existing && existing.socket !== socket && !options.replaceOwner) return "already-connected";
    const previousSessionId = this.sessionIdsBySocket.get(socket);
    const transferSessionId = existing ? registration.sessionId : previousSessionId;
    const previousRetained = transferSessionId
      ? this.retainedReservations.get(transferSessionId)
      : undefined;
    const previousCount = transferSessionId
      ? this.sessionReservations.get(transferSessionId)
      : undefined;
    const abandonedRetained =
      existing && previousSessionId && previousSessionId !== registration.sessionId
        ? this.retainedReservations.get(previousSessionId)
        : undefined;
    const abandonedCount =
      existing && previousSessionId && previousSessionId !== registration.sessionId
        ? this.sessionReservations.get(previousSessionId)
        : undefined;

    let retainedReservation: BudgetReservation | null = null;
    let sessionReservation: BudgetReservation | null = null;
    try {
      try {
        retainedReservation = previousRetained
          ? abandonedRetained
            ? this.retainedByteBudget.resizeWithCredit(
                previousRetained,
                retainedBytes,
                abandonedRetained,
              )
            : this.retainedByteBudget.resize(previousRetained, retainedBytes)
          : this.retainedByteBudget.reserve(retainedBytes);
        sessionReservation = previousCount ?? this.sessionBudget.reserve();
      } catch {
        return "capacity-exceeded";
      }

      const now = new Date().toISOString();
      if (existing && existing.socket !== socket) {
        this.sessionIdsBySocket.delete(existing.socket);
        this.rejectPendingCommandsForSession(
          registration.sessionId,
          new Error("The session owner reconnected."),
        );
      }
      if (previousSessionId && previousSessionId !== registration.sessionId) {
        // Detach the old identity without releasing the reservations transferred to its replacement.
        this.sessions.delete(previousSessionId);
        this.retainedReservations.delete(previousSessionId);
        this.sessionReservations.delete(previousSessionId);
        abandonedRetained?.release();
        abandonedCount?.release();
        this.rejectPendingCommandsForSession(
          previousSessionId,
          new Error("The session registration was replaced."),
        );
      }
      this.sessions.set(registration.sessionId, {
        registration,
        snapshot,
        socket,
        connectedAt: existing?.connectedAt ?? now,
        lastSeenAt: now,
      });
      this.sessionIdsBySocket.set(socket, registration.sessionId);
      this.retainedReservations.set(registration.sessionId, retainedReservation);
      this.sessionReservations.set(registration.sessionId, sessionReservation);
      retainedReservation = null;
      sessionReservation = null;
      return "registered";
    } finally {
      retainedReservation?.release();
      if (sessionReservation && sessionReservation !== previousCount) sessionReservation.release();
    }
  }

  updateSnapshot(
    socket: DaemonSessionSocket,
    sessionIdAssertion: string,
    snapshotInput: unknown,
  ): UpdateSnapshotResult {
    const ownedSessionId = this.sessionIdsBySocket.get(socket);
    if (!ownedSessionId || ownedSessionId !== sessionIdAssertion) {
      return "not-owner";
    }

    const entry = this.sessions.get(ownedSessionId);
    if (!entry || entry.socket !== socket) {
      return "not-owner";
    }

    let snapshot: SessionSnapshot<State> | null;
    try {
      snapshot = this.view.parseSnapshot(snapshotInput);
    } catch {
      return "invalid";
    }
    if (!snapshot) return "invalid";

    let retainedBytes: number;
    try {
      retainedBytes = retainedJsonBytes(
        { registration: entry.registration, snapshot },
        RETAINED_SESSION_OVERHEAD_BYTES,
      );
    } catch {
      return "invalid";
    }
    if (retainedBytes > this.limits.maxRetainedSessionBytes) return "capacity-exceeded";

    const previous = this.retainedReservations.get(ownedSessionId);
    if (!previous) return "capacity-exceeded";
    let reservation: BudgetReservation | null;
    try {
      reservation = this.retainedByteBudget.resize(previous, retainedBytes);
    } catch {
      return "capacity-exceeded";
    }
    try {
      this.sessions.set(ownedSessionId, {
        ...entry,
        snapshot,
        lastSeenAt: new Date().toISOString(),
      });
      this.retainedReservations.set(ownedSessionId, reservation);
      reservation = null;
      return "updated";
    } finally {
      reservation?.release();
    }
  }

  markSessionSeen(socket: DaemonSessionSocket, sessionIdAssertion: string): MarkSessionSeenResult {
    const ownedSessionId = this.sessionIdsBySocket.get(socket);
    if (!ownedSessionId || ownedSessionId !== sessionIdAssertion) {
      return "not-owner";
    }

    const entry = this.sessions.get(ownedSessionId);
    if (!entry || entry.socket !== socket) {
      return "not-owner";
    }

    this.sessions.set(ownedSessionId, {
      ...entry,
      lastSeenAt: new Date().toISOString(),
    });
    return "seen";
  }

  unregisterSocket(socket: DaemonSessionSocket) {
    const sessionId = this.sessionIdsBySocket.get(socket);
    if (!sessionId) {
      return;
    }

    this.removeSession(sessionId, new Error("The targeted session disconnected."));
  }

  pruneStaleSessions({ ttlMs, now = Date.now() }: { ttlMs: number; now?: number }) {
    // Far more than a TTL of wall time since the last sweep means the daemon was
    // almost certainly frozen (machine slept), not every session going silent at
    // once — forgive this sweep so sessions can heartbeat before the next.
    const wallClockJumped = this.lastPruneAt !== null && now - this.lastPruneAt > ttlMs;
    this.lastPruneAt = now;
    // Grace is per-sweep, not time-windowed: a live session must heartbeat again before the
    // next sweep would reap it. Safe while the recurring sweep is the only frequent pruner;
    // a polled /health would instead need a time-windowed grace covering the recovery gap.
    if (wallClockJumped) {
      return 0;
    }

    let removed = 0;
    const cutoff = now - ttlMs;

    for (const [sessionId, entry] of this.sessions.entries()) {
      const lastSeenAt = Date.parse(entry.lastSeenAt);
      if (!Number.isFinite(lastSeenAt) || lastSeenAt > cutoff) {
        continue;
      }

      this.removeSession(
        sessionId,
        new Error("The targeted session became stale and was removed from the session broker."),
      );
      removed += 1;
    }

    return removed;
  }

  /** Admit one command and schedule it through the target session's capacity-one FIFO. */
  dispatchCommand<ResultType extends CommandResult, CommandName extends ServerMessage["command"]>({
    selector,
    command,
    commandVersion = 1,
    input,
    timeoutMessage,
    timeoutMs = this.limits.defaultCommandTimeoutMs,
  }: {
    selector: SessionTargetInput;
    command: CommandName;
    commandVersion?: number;
    input: Extract<ServerMessage, { command: CommandName }>["input"];
    timeoutMessage: string;
    timeoutMs?: number;
  }) {
    if (this.shutdownError) throw this.shutdownError;
    if (!isValidBrokerRevision(commandVersion)) {
      throw new TypeError("Command version must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > this.limits.maxCommandTimeoutMs
    ) {
      throw new BrokerCapacityError("capacity-exceeded", "maxCommandTimeoutMs");
    }
    const session = resolveSessionTarget(this.listSessions(), selector);
    const entry = this.sessions.get(session.sessionId);
    if (!entry) return Promise.reject(new Error("The targeted session is no longer connected."));
    const sessionCount = this.commandQueues.get(session.sessionId)?.length ?? 0;
    if (sessionCount >= this.limits.maxCommandsPerSession) {
      throw new BrokerCapacityError("queue-full", "maxCommandsPerSession");
    }

    // Measure the untrusted app input before its parser and hold aggregate capacity until terminal.
    let inputBytes: number;
    try {
      inputBytes = retainedJsonBytes(input, 0);
    } catch {
      throw new BrokerProtocolError("invalid-app-payload");
    }
    if (inputBytes > this.limits.maxCommandInputBytes) {
      throw new BrokerCapacityError("capacity-exceeded", "maxCommandInputBytes");
    }
    const reservations = new ReservationGroup();
    try {
      reservations.add(this.commandBudget.reserve());
      const parsedInput = parseBrokerAppPayload(
        (value) => this.view.parseCommandInput(command, commandVersion, value),
        input,
      ) as Extract<ServerMessage, { command: CommandName }>["input"];
      if (retainedJsonBytes(parsedInput, 0) > this.limits.maxCommandInputBytes) {
        throw new BrokerCapacityError("capacity-exceeded", "maxCommandInputBytes");
      }
      const requestId = randomUUID();
      const serializedMessage = JSON.stringify({
        type: "command",
        requestId,
        command,
        commandVersion,
        input: parsedInput,
      });
      const queuedBytes = utf8ByteLength(serializedMessage) + QUEUED_COMMAND_OVERHEAD_BYTES;
      reservations.add(this.queuedCommandByteBudget.reserve(queuedBytes));

      return new Promise<ResultType>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const pending = this.pendingCommands.get(requestId);
          if (!pending) return;
          this.finishPending(pending, () => reject(new Error(timeoutMessage)));
        }, timeoutMs);
        const pending: PendingCommand<CommandResult> = {
          requestId,
          sessionId: session.sessionId,
          socket: entry.socket,
          command,
          commandVersion,
          serializedMessage,
          reservation: reservations,
          resolve: (result) => resolve(result as ResultType),
          reject,
          timeout,
          active: false,
        };
        this.pendingCommands.set(requestId, pending);
        const queue = this.commandQueues.get(session.sessionId) ?? [];
        queue.push(requestId);
        this.commandQueues.set(session.sessionId, queue);
        this.advanceSessionQueue(session.sessionId);
      });
    } catch (error) {
      reservations.release();
      throw error;
    }
  }

  handleCommandResult(
    socket: DaemonSessionSocket,
    message: {
      requestId: string;
      ok: boolean;
      result?: CommandResult;
      error?: string;
    },
  ): HandleCommandResult {
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending) {
      return "not-found";
    }

    if (pending.socket !== socket) {
      return "not-owner";
    }

    if (message.ok) {
      let result: CommandResult;
      try {
        if (retainedJsonBytes(message.result, 0) > this.limits.maxCommandResultBytes) {
          return "invalid";
        }
        result = parseBrokerAppPayload(
          (value) =>
            this.view.parseCommandResult(
              pending.command as ServerMessage["command"],
              pending.commandVersion,
              value,
            ),
          message.result,
        );
        if (retainedJsonBytes(result, 0) > this.limits.maxCommandResultBytes) return "invalid";
      } catch {
        // Keep the pending entry intact until the malformed producer is closed and normal
        // connection cleanup rejects it. This avoids resolving work from an invalid contract.
        return "invalid";
      }
      this.finishPending(pending, () => pending.resolve(result));
      return "handled";
    }

    this.finishPending(pending, () =>
      pending.reject(new Error(message.error ?? "The session failed to handle the command.")),
    );
    return "handled";
  }

  shutdown(error = new Error("The session broker daemon shut down.")) {
    if (this.shutdownError) return;
    this.shutdownError = error;

    for (const pending of this.pendingCommands.values()) {
      this.finishPending(pending, () => pending.reject(error), false);
    }

    this.commandQueues.clear();
    this.sessionIdsBySocket.clear();
    this.sessions.clear();
    for (const reservation of this.retainedReservations.values()) reservation.release();
    for (const reservation of this.sessionReservations.values()) reservation.release();
    this.retainedReservations.clear();
    this.sessionReservations.clear();
  }

  /** Write the oldest queued command only when the session has no active command. */
  private advanceSessionQueue(sessionId: string): void {
    const queue = this.commandQueues.get(sessionId);
    if (!queue?.length) {
      this.commandQueues.delete(sessionId);
      return;
    }
    const first = this.pendingCommands.get(queue[0]!);
    if (!first || first.active) return;
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.socket !== first.socket) {
      this.finishPending(first, () =>
        first.reject(new Error("The targeted session is no longer connected.")),
      );
      return;
    }
    first.active = true;
    try {
      const accepted = entry.socket.send(first.serializedMessage);
      if (accepted === false) throw new BrokerCapacityError("busy", "outbound");
    } catch (error) {
      this.finishPending(first, () =>
        first.reject(
          error instanceof Error
            ? error
            : new Error("The targeted session could not receive the command."),
        ),
      );
    }
  }

  /** Complete one command exactly once, release reservations, and advance its session FIFO. */
  private finishPending(
    pending: PendingCommand<CommandResult>,
    settle: () => void,
    advance = true,
  ): void {
    if (this.pendingCommands.get(pending.requestId) !== pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommands.delete(pending.requestId);
    const queue = this.commandQueues.get(pending.sessionId);
    if (queue) {
      const index = queue.indexOf(pending.requestId);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.commandQueues.delete(pending.sessionId);
    }
    pending.reservation.release();
    settle();
    if (advance) this.advanceSessionQueue(pending.sessionId);
  }

  /** Resolve one live session selector into the full in-memory registration entry. */
  private getSessionEntry(selector: SessionTargetSelector) {
    const session = resolveSessionTarget(this.listSessions(), selector);
    const entry = this.sessions.get(session.sessionId);
    if (!entry) {
      throw new Error("The targeted session is no longer connected.");
    }

    return entry;
  }

  private removeSession(sessionId: string, error: Error) {
    const entry = this.sessions.get(sessionId);
    // Centralize all session removal here so socket maps, session maps, and pending command
    // rejection stay in sync across disconnects, stale pruning, and incompatible reconnects.
    if (!entry) {
      return;
    }

    this.sessions.delete(sessionId);
    this.retainedReservations.get(sessionId)?.release();
    this.retainedReservations.delete(sessionId);
    this.sessionReservations.get(sessionId)?.release();
    this.sessionReservations.delete(sessionId);
    if (this.sessionIdsBySocket.get(entry.socket) === sessionId) {
      this.sessionIdsBySocket.delete(entry.socket);
    }

    this.rejectPendingCommandsForSession(sessionId, error);
  }

  private rejectPendingCommandsForSession(sessionId: string, error: Error) {
    for (const pending of this.pendingCommands.values()) {
      if (pending.sessionId !== sessionId) continue;
      this.finishPending(pending, () => pending.reject(error), false);
    }
    this.commandQueues.delete(sessionId);
  }
}
