import { randomUUID } from "node:crypto";
import { isValidBrokerRevision } from "./auth";
import { parseBrokerAppPayload } from "./validation";
import { matchesSessionSelector, repoSelectorDistance, type SelectableSession } from "./selectors";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
  SessionTargetInput,
} from "./types";

interface PendingCommand<Result> {
  sessionId: string;
  socket: DaemonSessionSocket;
  command: string;
  commandVersion: number;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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

export type RegisterSessionResult = "registered" | "invalid" | "already-connected";
export type UpdateSnapshotResult = "updated" | "invalid" | "not-owner";
export type MarkSessionSeenResult = "seen" | "not-owner";
export type HandleCommandResult = "handled" | "not-found" | "not-owner" | "invalid";

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
  private lastPruneAt: number | null = null;

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
  ) {}

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
  ): RegisterSessionResult {
    let registration: SessionRegistration<Info> | null;
    let snapshot: SessionSnapshot<State> | null;
    try {
      registration = this.view.parseRegistration(registrationInput);
      snapshot = this.view.parseSnapshot(snapshotInput);
    } catch {
      return "invalid";
    }
    if (!registration || !snapshot) return "invalid";

    const existing = this.sessions.get(registration.sessionId);
    if (existing && existing.socket !== socket) {
      // Reconnect proof is not available yet, so an unauthenticated peer cannot supersede a live
      // owner. Once the owner closes, normal unregister cleanup makes this ID available again.
      return "already-connected";
    }

    const previousSessionId = this.sessionIdsBySocket.get(socket);
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
    return "registered";
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

    this.sessions.set(ownedSessionId, {
      ...entry,
      snapshot,
      lastSeenAt: new Date().toISOString(),
    });
    return "updated";
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

  /** Dispatch one app-owned command through the generic broker transport. */
  dispatchCommand<ResultType extends CommandResult, CommandName extends ServerMessage["command"]>({
    selector,
    command,
    commandVersion = 1,
    input,
    timeoutMessage,
    timeoutMs = 15_000,
  }: {
    selector: SessionTargetInput;
    command: CommandName;
    commandVersion?: number;
    input: Extract<ServerMessage, { command: CommandName }>["input"];
    timeoutMessage: string;
    timeoutMs?: number;
  }) {
    if (!isValidBrokerRevision(commandVersion)) {
      throw new TypeError("Command version must be a positive safe integer.");
    }
    const session = resolveSessionTarget(this.listSessions(), selector);
    const parsedInput = parseBrokerAppPayload(
      (value) => this.view.parseCommandInput(command, commandVersion, value),
      input,
    ) as Extract<ServerMessage, { command: CommandName }>["input"];
    const requestId = randomUUID();

    return new Promise<ResultType>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      // Record the pending request before sending so synchronous transport failures and later close
      // events can both resolve the same command bookkeeping path.

      const entry = this.sessions.get(session.sessionId);
      if (!entry) {
        clearTimeout(timeout);
        reject(new Error("The targeted session is no longer connected."));
        return;
      }

      this.pendingCommands.set(requestId, {
        sessionId: session.sessionId,
        socket: entry.socket,
        command,
        commandVersion,
        resolve: (result) => resolve(result as ResultType),
        reject,
        timeout,
      });

      try {
        const message = {
          type: "command",
          requestId,
          command,
          commandVersion,
          input: parsedInput,
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
        result = parseBrokerAppPayload(
          (value) =>
            this.view.parseCommandResult(
              pending.command as ServerMessage["command"],
              pending.commandVersion,
              value,
            ),
          message.result,
        );
      } catch {
        // Keep the pending entry intact until the malformed producer is closed and normal
        // connection cleanup rejects it. This avoids resolving work from an invalid contract.
        return "invalid";
      }
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(message.requestId);
      pending.resolve(result);
      return "handled";
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(message.requestId);
    pending.reject(new Error(message.error ?? "The session failed to handle the command."));
    return "handled";
  }

  shutdown(error = new Error("The session broker daemon shut down.")) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }

    this.sessionIdsBySocket.clear();
    this.sessions.clear();
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
    if (this.sessionIdsBySocket.get(entry.socket) === sessionId) {
      this.sessionIdsBySocket.delete(entry.socket);
    }

    this.rejectPendingCommandsForSession(sessionId, error);
  }

  private rejectPendingCommandsForSession(sessionId: string, error: Error) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      if (pending.sessionId !== sessionId) {
        continue;
      }

      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }
}
