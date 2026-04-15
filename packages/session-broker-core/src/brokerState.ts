import { randomUUID } from "node:crypto";
import { matchesSessionSelector, type SelectableSession } from "./selectors";
import type {
  SessionRegistration,
  SessionServerMessage,
  SessionSnapshot,
  SessionTargetInput,
} from "./types";

interface PendingCommand<Result> {
  sessionId: string;
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
> {
  parseRegistration: (value: unknown) => SessionRegistration<Info> | null;
  parseSnapshot: (value: unknown) => SessionSnapshot<State> | null;
  buildListedSession: (entry: SessionBrokerEntry<Info, State>) => ListedSession;
  buildSelectedContext: (session: ListedSession) => SelectedContext;
  buildSessionReview: (
    entry: SessionBrokerEntry<Info, State>,
    options: { includePatch?: boolean },
  ) => SessionReview;
  listComments: (session: ListedSession, filter: { filePath?: string }) => SessionCommentSummary[];
}

export type UpdateSnapshotResult = "updated" | "invalid" | "not-found";

export interface SessionTargetSelector {
  sessionId?: string;
  sessionPath?: string;
  repoRoot?: string;
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
    const matches = sessions.filter((session) => matchesSessionSelector(session, selector));
    if (matches.length === 0) {
      throw new Error(`No active session matches repoRoot ${selector.repoRoot}.`);
    }

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

  constructor(
    private view: SessionBrokerViewAdapter<
      Info,
      State,
      ListedSession,
      SelectedContext,
      SessionReview,
      SessionCommentSummary
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
    options: { includePatch?: boolean } = {},
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

    const previousSessionId = this.sessionIdsBySocket.get(socket);
    if (previousSessionId && previousSessionId !== registration.sessionId) {
      this.unregisterSocket(socket);
    }

    const existing = this.sessions.get(registration.sessionId);
    if (existing && existing.socket !== socket) {
      this.sessionIdsBySocket.delete(existing.socket);
      this.rejectPendingCommandsForSession(
        registration.sessionId,
        new Error("Session reconnected before the command completed."),
      );
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
    return true;
  }

  updateSnapshot(sessionId: string, snapshotInput: unknown): UpdateSnapshotResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return "not-found";
    }

    const snapshot = this.view.parseSnapshot(snapshotInput);
    if (!snapshot) {
      return "invalid";
    }

    this.sessions.set(sessionId, {
      ...entry,
      snapshot,
      lastSeenAt: new Date().toISOString(),
    });
    return "updated";
  }

  markSessionSeen(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.sessions.set(sessionId, {
      ...entry,
      lastSeenAt: new Date().toISOString(),
    });
  }

  unregisterSocket(socket: DaemonSessionSocket) {
    const sessionId = this.sessionIdsBySocket.get(socket);
    if (!sessionId) {
      return;
    }

    this.removeSession(sessionId, new Error("The targeted session disconnected."));
  }

  pruneStaleSessions({ ttlMs, now = Date.now() }: { ttlMs: number; now?: number }) {
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
    const requestId = randomUUID();

    return new Promise<ResultType>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      this.pendingCommands.set(requestId, {
        sessionId: session.sessionId,
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

  handleCommandResult(message: {
    requestId: string;
    ok: boolean;
    result?: CommandResult;
    error?: string;
  }) {
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(message.requestId);

    if (message.ok) {
      pending.resolve(message.result as CommandResult);
      return;
    }

    pending.reject(new Error(message.error ?? "The session failed to handle the command."));
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
