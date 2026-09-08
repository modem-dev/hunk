import {
  SessionBrokerState,
  type HandleCommandResult,
  type MarkSessionSeenResult,
  type RegisterSessionResult,
  type SessionBrokerEntry,
  type SessionBrokerLimitOptions,
  type SessionBrokerLimits,
  type SessionRegistration,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionTargetInput,
  type SessionTargetSelector,
  type UpdateSnapshotResult,
} from "@hunk/session-broker-core";
import type { SessionBrokerProtocolParsers } from "./protocolParsers";

/** Minimal socket shape the broker needs in order to target one live session. */
export interface SessionBrokerPeer {
  send(data: string): unknown;
  close?(code?: number, reason?: string): unknown;
  markAuthenticated?(): void;
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

export interface SessionBrokerOptions<
  Info,
  State,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  protocolParsers: SessionBrokerProtocolParsers<Info, State, ServerMessage, CommandResult>;
  limits?: SessionBrokerLimitOptions["limits"];
  unsafeLimits?: SessionBrokerLimitOptions["unsafeLimits"];
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
  /** The parser registry bound to this controller's state and command contracts. */
  readonly protocolParsers: SessionBrokerProtocolParsers<
    unknown,
    unknown,
    ServerMessage,
    CommandResult
  >;
  readonly limits?: Readonly<SessionBrokerLimits>;
  listSessions(): SessionView[];
  getSession(selector: SessionTargetSelector): SessionView;
  resolveSessionId(selector: SessionTargetSelector): string;
  getSessionIds(): string[];
  getSessionCount(): number;
  getPendingCommandCount(): number;
  registerSession(
    connection: SessionBrokerPeer,
    registrationInput: unknown,
    snapshotInput: unknown,
    options?: { replaceOwner?: boolean },
  ): RegisterSessionResult;
  updateSnapshot(
    connection: SessionBrokerPeer,
    sessionIdAssertion: string,
    snapshotInput: unknown,
  ): UpdateSnapshotResult;
  markSessionSeen(connection: SessionBrokerPeer, sessionIdAssertion: string): MarkSessionSeenResult;
  unregisterConnection(connection: SessionBrokerPeer): void;
  pruneStaleSessions(options: { ttlMs: number; now?: number }): number;
  dispatchCommand(options: {
    selector: SessionTargetInput;
    command: ServerMessage["command"];
    commandVersion?: number;
    input: unknown;
    timeoutMessage: string;
    timeoutMs?: number;
  }): Promise<CommandResult>;
  handleCommandResult(
    connection: SessionBrokerPeer,
    message: {
      requestId: string;
      ok: boolean;
      result?: CommandResult;
      error?: string;
    },
  ): HandleCommandResult;
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
  readonly protocolParsers: SessionBrokerProtocolParsers<Info, State, ServerMessage, CommandResult>;

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
    SessionBrokerOptions<Info, State, ServerMessage, CommandResult>["describeSession"]
  >;

  constructor(options: SessionBrokerOptions<Info, State, ServerMessage, CommandResult>) {
    this.describeSession =
      options.describeSession ?? ((registration, _snapshot) => defaultSessionTitle(registration));
    this.protocolParsers = options.protocolParsers;

    this.state = new SessionBrokerState(
      {
        parseRegistration: (value) => {
          try {
            return this.protocolParsers.parseRegistration(value);
          } catch {
            return null;
          }
        },
        parseSnapshot: (value) => {
          try {
            return this.protocolParsers.parseSnapshot(value);
          } catch {
            return null;
          }
        },
        parseCommandInput: (command, version, value) =>
          this.protocolParsers.parseCommandInput(command, version, value),
        parseCommandResult: (command, version, value) =>
          this.protocolParsers.parseCommandResult(command, version, value),
        buildListedSession: (entry) => this.buildRecord(entry),
        buildSelectedContext: (session) => session,
        buildSessionReview: (entry) => this.buildRecord(entry),
        listComments: () => [],
      },
      {
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.unsafeLimits ? { unsafeLimits: options.unsafeLimits } : {}),
      },
    );
  }

  get limits() {
    return this.state.limits;
  }

  listSessions() {
    return this.state.listSessions();
  }

  getSession(selector: SessionTargetSelector) {
    return this.state.getSession(selector);
  }

  resolveSessionId(selector: SessionTargetSelector) {
    return this.state.getSession(selector).sessionId;
  }

  getSessionIds() {
    return this.state.listSessions().map((session) => session.sessionId);
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
    options?: { replaceOwner?: boolean },
  ) {
    return this.state.registerSession(connection, registrationInput, snapshotInput, options);
  }

  updateSnapshot(
    connection: SessionBrokerPeer,
    sessionIdAssertion: string,
    snapshotInput: unknown,
  ): UpdateSnapshotResult {
    return this.state.updateSnapshot(connection, sessionIdAssertion, snapshotInput);
  }

  markSessionSeen(connection: SessionBrokerPeer, sessionIdAssertion: string) {
    return this.state.markSessionSeen(connection, sessionIdAssertion);
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
    commandVersion,
    input,
    timeoutMessage,
    timeoutMs,
  }: {
    selector: SessionTargetInput;
    command: CommandName;
    commandVersion?: number;
    input: Extract<ServerMessage, { command: CommandName }>["input"];
    timeoutMessage: string;
    timeoutMs?: number;
  }): Promise<ResultType>;
  dispatchCommand({
    selector,
    command,
    commandVersion,
    input,
    timeoutMessage,
    timeoutMs,
  }: {
    selector: SessionTargetInput;
    command: ServerMessage["command"];
    commandVersion?: number;
    input: unknown;
    timeoutMessage: string;
    timeoutMs?: number;
  }) {
    return this.state.dispatchCommand<CommandResult, ServerMessage["command"]>({
      selector,
      command,
      commandVersion,
      input: input as Extract<ServerMessage, { command: ServerMessage["command"] }>["input"],
      timeoutMessage,
      timeoutMs,
    });
  }

  handleCommandResult(
    connection: SessionBrokerPeer,
    message: {
      requestId: string;
      ok: boolean;
      result?: CommandResult;
      error?: string;
    },
  ) {
    return this.state.handleCommandResult(connection, message);
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
