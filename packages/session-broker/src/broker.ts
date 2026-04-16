import {
  SessionBrokerState,
  type SessionBrokerEntry,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionTargetInput,
  type SessionTargetSelector,
  type UpdateSnapshotResult,
} from "@hunk/session-broker-core";

/** Minimal socket shape the broker needs in order to target one live session. */
export interface SessionBrokerPeer {
  send(data: string): unknown;
  close?(code?: number, reason?: string): unknown;
}

/** One raw live session record with the original registration and snapshot payloads intact. */
export interface SessionBrokerRecord<Info = unknown, State = unknown> {
  sessionId: string;
  cwd: string;
  repoRoot?: string;
  title: string;
  connectedAt: string;
  lastSeenAt: string;
  registration: SessionRegistration<Info>;
  snapshot: SessionSnapshot<State>;
}

export interface SessionBrokerOptions<Info, State> {
  parseRegistration: (value: unknown) => SessionRegistration<Info> | null;
  parseSnapshot: (value: unknown) => SessionSnapshot<State> | null;
  describeSession?: (
    registration: SessionRegistration<Info>,
    snapshot: SessionSnapshot<State>,
  ) => string;
}

/** Shared controller surface consumed by runtime-neutral daemon adapters. */
export interface SessionBrokerController<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  listSessions(): SessionView[];
  getSession(selector: SessionTargetSelector): SessionView;
  getSessionCount(): number;
  getPendingCommandCount(): number;
  registerSession(
    connection: SessionBrokerPeer,
    registrationInput: unknown,
    snapshotInput: unknown,
  ): boolean;
  updateSnapshot(sessionId: string, snapshotInput: unknown): UpdateSnapshotResult;
  markSessionSeen(sessionId: string): void;
  unregisterConnection(connection: SessionBrokerPeer): void;
  pruneStaleSessions(options: { ttlMs: number; now?: number }): number;
  dispatchCommand(options: {
    selector: SessionTargetInput;
    command: ServerMessage["command"];
    input: unknown;
    timeoutMessage: string;
    timeoutMs?: number;
  }): Promise<CommandResult>;
  handleCommandResult(message: {
    requestId: string;
    ok: boolean;
    result?: CommandResult;
    error?: string;
  }): void;
  shutdown(error?: Error): void;
}

function defaultSessionTitle<Info>(registration: SessionRegistration<Info>) {
  const info = registration.info;
  if (info && typeof info === "object") {
    const title = (info as { title?: unknown }).title;
    if (typeof title === "string" && title.length > 0) {
      return title;
    }
  }

  return registration.sessionId;
}

/**
 * Wrap the lower-level broker core in one raw-session API so apps do not need to define a large
 * projection adapter just to store registrations, snapshots, and command routing state.
 */
export class SessionBroker<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> implements SessionBrokerController<
  SessionBrokerRecord<Info, State>,
  ServerMessage,
  CommandResult
> {
  private readonly state: SessionBrokerState<
    Info,
    State,
    ServerMessage,
    CommandResult,
    SessionBrokerRecord<Info, State>,
    SessionBrokerRecord<Info, State>,
    SessionBrokerRecord<Info, State>,
    never
  >;

  private readonly describeSession: NonNullable<
    SessionBrokerOptions<Info, State>["describeSession"]
  >;

  constructor(options: SessionBrokerOptions<Info, State>) {
    this.describeSession =
      options.describeSession ?? ((registration, _snapshot) => defaultSessionTitle(registration));

    this.state = new SessionBrokerState({
      parseRegistration: options.parseRegistration,
      parseSnapshot: options.parseSnapshot,
      buildListedSession: (entry) => this.buildRecord(entry),
      buildSelectedContext: (session) => session,
      buildSessionReview: (entry) => this.buildRecord(entry),
      listComments: () => [],
    });
  }

  listSessions() {
    return this.state.listSessions();
  }

  getSession(selector: SessionTargetSelector) {
    return this.state.getSession(selector);
  }

  getSessionCount() {
    return this.state.getSessionCount();
  }

  getPendingCommandCount() {
    return this.state.getPendingCommandCount();
  }

  registerSession(
    connection: SessionBrokerPeer,
    registrationInput: unknown,
    snapshotInput: unknown,
  ) {
    return this.state.registerSession(connection, registrationInput, snapshotInput);
  }

  updateSnapshot(sessionId: string, snapshotInput: unknown): UpdateSnapshotResult {
    return this.state.updateSnapshot(sessionId, snapshotInput);
  }

  markSessionSeen(sessionId: string) {
    this.state.markSessionSeen(sessionId);
  }

  unregisterConnection(connection: SessionBrokerPeer) {
    this.state.unregisterSocket(connection);
  }

  pruneStaleSessions({ ttlMs, now }: { ttlMs: number; now?: number }) {
    return this.state.pruneStaleSessions({ ttlMs, now });
  }

  dispatchCommand<ResultType extends CommandResult, CommandName extends ServerMessage["command"]>({
    selector,
    command,
    input,
    timeoutMessage,
    timeoutMs,
  }: {
    selector: SessionTargetInput;
    command: CommandName;
    input: Extract<ServerMessage, { command: CommandName }>["input"];
    timeoutMessage: string;
    timeoutMs?: number;
  }): Promise<ResultType>;
  dispatchCommand({
    selector,
    command,
    input,
    timeoutMessage,
    timeoutMs,
  }: {
    selector: SessionTargetInput;
    command: ServerMessage["command"];
    input: unknown;
    timeoutMessage: string;
    timeoutMs?: number;
  }) {
    return this.state.dispatchCommand<CommandResult, ServerMessage["command"]>({
      selector,
      command,
      input: input as Extract<ServerMessage, { command: ServerMessage["command"] }>["input"],
      timeoutMessage,
      timeoutMs,
    });
  }

  handleCommandResult(message: {
    requestId: string;
    ok: boolean;
    result?: CommandResult;
    error?: string;
  }) {
    this.state.handleCommandResult(message);
  }

  shutdown(error = new Error("The session broker shut down.")) {
    this.state.shutdown(error);
  }

  /** Build one raw record from the core entry plus a host-defined title/label. */
  private buildRecord(entry: SessionBrokerEntry<Info, State>): SessionBrokerRecord<Info, State> {
    return {
      sessionId: entry.registration.sessionId,
      cwd: entry.registration.cwd,
      repoRoot: entry.registration.repoRoot,
      title: this.describeSession(entry.registration, entry.snapshot),
      connectedAt: entry.connectedAt,
      lastSeenAt: entry.lastSeenAt,
      registration: entry.registration,
      snapshot: entry.snapshot,
    };
  }
}
