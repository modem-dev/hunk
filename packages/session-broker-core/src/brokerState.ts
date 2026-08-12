import { randomUUID } from "node:crypto";
import {
  MAX_LIVE_SESSIONS,
  MAX_PENDING_COMMANDS,
  MAX_PENDING_COMMANDS_PER_SESSION,
  MAX_SESSION_METADATA_BYTES,
  utf8ByteLength,
} from "./limits";
import { matchesSessionSelector, repoSelectorDistance, type SelectableSession } from "./selectors";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
  SessionTargetInput,
} from "./types";

interface PendingCommand<Result> {
  sessionId: string;
  command: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface SessionBrokerStateLimits {
  globalPendingCommands: number;
  perSessionPendingCommands: number;
  liveSessions: number;
  aggregateMetadataBytes: number;
}

/** Typed overload rejection raised before a command consumes broker transport state. */
export class SessionCommandCapacityError extends Error {
  readonly code = "session-command-capacity" as const;

  constructor(readonly scope: "global" | "session" | "connection") {
    super(`Session command capacity exceeded for ${scope}.`);
    this.name = "SessionCommandCapacityError";
  }
}

/** Typed capacity rejection raised before retaining registration or snapshot metadata. */
export class SessionMetadataCapacityError extends Error {
  readonly code = "session-metadata-capacity" as const;

  constructor(readonly scope: "sessions" | "bytes") {
    super(`Session metadata capacity exceeded for ${scope}.`);
    this.name = "SessionMetadataCapacityError";
  }
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
> {
  parseRegistration: (value: unknown) => SessionRegistration<Info> | null;
  parseSnapshot: (value: unknown) => SessionSnapshot<State> | null;
  buildListedSession: (entry: SessionBrokerEntry<Info, State>) => ListedSession;
  buildSelectedContext: (session: ListedSession) => SelectedContext;
  buildSessionReview: (
    entry: SessionBrokerEntry<Info, State>,
    options: { includePatch?: boolean; includeNotes?: boolean },
  ) => SessionReview;
  listComments: (session: ListedSession, filter: { filePath?: string }) => SessionCommentSummary[];
}

export type UpdateSnapshotResult = "updated" | "invalid" | "not-found" | "not-owner" | "capacity";

export type SessionTargetSelector = SessionTargetInput;

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
  private sessions = new Map<string, SessionBrokerEntry<Info, State>>();
  private sessionIdsBySocket = new Map<DaemonSessionSocket, string>();
  private pendingCommands = new Map<string, PendingCommand<CommandResult>>();
  private metadataBytesBySession = new Map<string, number>();
  private aggregateMetadataBytes = 0;
  private lastPruneAt: number | null = null;

  private readonly limits: SessionBrokerStateLimits;

  constructor(
    private view: SessionBrokerViewAdapter<
      Info,
      State,
      ListedSession,
      SelectedContext,
      SessionReview,
      SessionCommentSummary
    >,
    limits: Partial<SessionBrokerStateLimits> = {},
  ) {
    this.limits = {
      globalPendingCommands: limits.globalPendingCommands ?? MAX_PENDING_COMMANDS,
      perSessionPendingCommands:
        limits.perSessionPendingCommands ?? MAX_PENDING_COMMANDS_PER_SESSION,
      liveSessions: limits.liveSessions ?? MAX_LIVE_SESSIONS,
      aggregateMetadataBytes: limits.aggregateMetadataBytes ?? MAX_SESSION_METADATA_BYTES,
    };
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

  getAggregateMetadataBytes() {
    return this.aggregateMetadataBytes;
  }

  /** Return whether one live session is owned by the supplied transport. */
  ownsSession(socket: DaemonSessionSocket, sessionId: string) {
    return this.sessions.get(sessionId)?.socket === socket;
  }

  registerSession(socket: DaemonSessionSocket, registrationInput: unknown, snapshotInput: unknown) {
    const registration = this.view.parseRegistration(registrationInput);
    const snapshot = this.view.parseSnapshot(snapshotInput);
    if (!registration || !snapshot) {
      const previousSessionId = this.sessionIdsBySocket.get(socket);
      if (previousSessionId) {
        // Drop any stale session already tied to this socket so an incompatible replacement
        // payload cannot leave old review data behind after an upgrade or reload.
        this.removeSession(
          previousSessionId,
          new Error("The session sent an incompatible registration payload."),
        );
      }

      return false;
    }

    return this.registerParsedSession(socket, registration, snapshot);
  }

  /** Retain already parsed app metadata so specialized brokers can share one normalized graph. */
  protected registerParsedSession(
    socket: DaemonSessionSocket,
    registration: SessionRegistration<Info>,
    snapshot: SessionSnapshot<State>,
  ) {
    const existing = this.sessions.get(registration.sessionId);
    // Session ids are capabilities owned by one live transport. A second socket cannot replace
    // an active producer; reconnect is allowed only after the old owner disconnects or expires.
    if (existing && existing.socket !== socket) return false;

    const previousSessionId = this.sessionIdsBySocket.get(socket);
    const replacedSessionIds = new Set<string>();
    if (existing) replacedSessionIds.add(registration.sessionId);
    if (previousSessionId) replacedSessionIds.add(previousSessionId);
    const metadataBytes = this.measureMetadataBytes(registration, snapshot);
    const retainedBytes = [...replacedSessionIds].reduce(
      (total, sessionId) => total + (this.metadataBytesBySession.get(sessionId) ?? 0),
      0,
    );
    if (this.sessions.size - replacedSessionIds.size + 1 > this.limits.liveSessions) {
      throw new SessionMetadataCapacityError("sessions");
    }
    if (
      this.aggregateMetadataBytes - retainedBytes + metadataBytes >
      this.limits.aggregateMetadataBytes
    ) {
      throw new SessionMetadataCapacityError("bytes");
    }

    if (previousSessionId && previousSessionId !== registration.sessionId) {
      this.unregisterSocket(socket);
    }

    const now = new Date().toISOString();
    this.sessions.set(registration.sessionId, {
      registration,
      snapshot,
      socket,
      connectedAt: now,
      lastSeenAt: now,
    });
    this.sessionIdsBySocket.set(socket, registration.sessionId);
    this.setMetadataBytes(registration.sessionId, metadataBytes);
    return true;
  }

  updateSnapshot(
    socket: DaemonSessionSocket,
    sessionId: string,
    snapshotInput: unknown,
  ): UpdateSnapshotResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) return "not-found";
    if (entry.socket !== socket) return "not-owner";
    const snapshot = this.view.parseSnapshot(snapshotInput);
    return snapshot ? this.updateParsedSnapshot(socket, sessionId, snapshot) : "invalid";
  }

  /** Update from one already parsed snapshot without retaining a duplicate normalized graph. */
  protected updateParsedSnapshot(
    socket: DaemonSessionSocket,
    sessionId: string,
    snapshot: SessionSnapshot<State>,
  ): UpdateSnapshotResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) return "not-found";
    if (entry.socket !== socket) return "not-owner";
    const metadataBytes = this.measureMetadataBytes(entry.registration, snapshot);
    const previousBytes = this.metadataBytesBySession.get(sessionId) ?? 0;
    if (
      this.aggregateMetadataBytes - previousBytes + metadataBytes >
      this.limits.aggregateMetadataBytes
    ) {
      return "capacity";
    }

    this.sessions.set(sessionId, {
      ...entry,
      snapshot,
      lastSeenAt: new Date().toISOString(),
    });
    this.setMetadataBytes(sessionId, metadataBytes);
    return "updated";
  }

  markSessionSeen(socket: DaemonSessionSocket, sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.socket !== socket) {
      return false;
    }

    this.sessions.set(sessionId, {
      ...entry,
      lastSeenAt: new Date().toISOString(),
    });
    return true;
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

  /** Dispatch one app-owned command through the generic broker transport. */
  dispatchCommand<ResultType extends CommandResult, CommandName extends ServerMessage["command"]>({
    selector,
    command,
    input,
    timeoutMessage,
    timeoutMs = 15_000,
  }: {
    selector: SessionTargetInput;
    command: CommandName;
    input: Extract<ServerMessage, { command: CommandName }>["input"];
    timeoutMessage: string;
    timeoutMs?: number;
  }) {
    const session = resolveSessionTarget(this.listSessions(), selector);
    if (this.pendingCommands.size >= this.limits.globalPendingCommands) {
      return Promise.reject<ResultType>(new SessionCommandCapacityError("global"));
    }
    let sessionPending = 0;
    for (const pending of this.pendingCommands.values()) {
      if (pending.sessionId === session.sessionId) sessionPending += 1;
    }
    if (sessionPending >= this.limits.perSessionPendingCommands) {
      return Promise.reject<ResultType>(new SessionCommandCapacityError("session"));
    }
    const requestId = randomUUID();

    return new Promise<ResultType>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      // Record the pending request before sending so synchronous transport failures and later close
      // events can both resolve the same command bookkeeping path.

      this.pendingCommands.set(requestId, {
        sessionId: session.sessionId,
        command,
        resolve: (result) => resolve(result as ResultType),
        reject,
        timeout,
      });

      const entry = this.sessions.get(session.sessionId);
      if (!entry) {
        clearTimeout(timeout);
        this.pendingCommands.delete(requestId);
        reject(new Error("The targeted session is no longer connected."));
        return;
      }

      try {
        const message = {
          type: "command",
          requestId,
          command,
          input,
        } as Extract<ServerMessage, { command: CommandName }>;

        entry.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCommands.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("The targeted session could not receive the command."),
        );
      }
    });
  }

  handleCommandResult(
    socket: DaemonSessionSocket,
    message: {
      requestId: string;
      ok: boolean;
      result?: CommandResult;
      error?: string;
      errorCode?: string;
    },
  ) {
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending) {
      return "not-found" as const;
    }
    const entry = this.sessions.get(pending.sessionId);
    if (!entry || entry.socket !== socket) {
      return "not-owner" as const;
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(message.requestId);

    if (message.ok) {
      pending.resolve(message.result as CommandResult);
      return "accepted" as const;
    }

    pending.reject(
      message.errorCode === "session-command-capacity"
        ? new SessionCommandCapacityError("connection")
        : new Error(message.error ?? "The session failed to handle the command."),
    );
    return "accepted" as const;
  }

  shutdown(error = new Error("The session broker daemon shut down.")) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }

    this.sessionIdsBySocket.clear();
    this.sessions.clear();
    this.metadataBytesBySession.clear();
    this.aggregateMetadataBytes = 0;
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

  /** Measure exactly the normalized registration and snapshot retained for one session. */
  private measureMetadataBytes(
    registration: SessionRegistration<Info>,
    snapshot: SessionSnapshot<State>,
  ) {
    return utf8ByteLength(JSON.stringify({ registration, snapshot }));
  }

  /** Replace one session's accounted metadata size without drifting aggregate totals. */
  private setMetadataBytes(sessionId: string, metadataBytes: number) {
    this.aggregateMetadataBytes -= this.metadataBytesBySession.get(sessionId) ?? 0;
    this.metadataBytesBySession.set(sessionId, metadataBytes);
    this.aggregateMetadataBytes += metadataBytes;
  }

  private removeSession(sessionId: string, error: Error) {
    const entry = this.sessions.get(sessionId);
    // Centralize all session removal here so socket maps, session maps, and pending command
    // rejection stay in sync across disconnects, stale pruning, and incompatible reconnects.
    if (!entry) {
      return;
    }

    this.sessions.delete(sessionId);
    this.aggregateMetadataBytes -= this.metadataBytesBySession.get(sessionId) ?? 0;
    this.metadataBytesBySession.delete(sessionId);
    if (this.sessionIdsBySocket.get(entry.socket) === sessionId) {
      this.sessionIdsBySocket.delete(entry.socket);
    }

    this.rejectPendingCommandsForSession(sessionId, error);
  }

  /** Reject pending work for one session, optionally restricted to selected command names. */
  rejectPendingCommandsForSession(
    sessionId: string,
    error: Error,
    matchesCommand: (command: string) => boolean = () => true,
  ) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      if (pending.sessionId !== sessionId || !matchesCommand(pending.command)) {
        continue;
      }

      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }
}
