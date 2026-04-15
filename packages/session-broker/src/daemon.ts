import type { SessionServerMessage } from "@hunk/session-broker-core";
import type { SessionBroker, SessionBrokerPeer, SessionBrokerRecord } from "./broker";
import {
  DEFAULT_SESSION_BROKER_API_PATH,
  DEFAULT_SESSION_BROKER_CAPABILITIES_PATH,
  DEFAULT_SESSION_BROKER_HEALTH_PATH,
  DEFAULT_SESSION_BROKER_SOCKET_PATH,
  type SessionBrokerCapabilities,
  type SessionBrokerDaemonRequest,
  type SessionBrokerDaemonResponse,
  type SessionBrokerHealth,
  type SessionBrokerHttpPaths,
} from "./types";

const DEFAULT_STALE_SESSION_TTL_MS = 45_000;
const DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const INCOMPATIBLE_PAYLOAD_CLOSE_CODE = 1008;

export interface SessionBrokerDaemonOptions<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  broker: SessionBroker<Info, State, ServerMessage, CommandResult>;
  capabilities?: SessionBrokerCapabilities;
  paths?: Partial<SessionBrokerHttpPaths>;
  idleTimeoutMs?: number;
  staleSessionTtlMs?: number;
  staleSessionSweepIntervalMs?: number;
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function parseSocketEnvelope(message: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string"
    ? (parsed as object as { type: string } & Record<string, unknown>)
    : null;
}

async function parseJsonRequest<CommandName extends string = string, CommandInput = unknown>(
  request: Request,
) {
  try {
    return (await request.json()) as SessionBrokerDaemonRequest<CommandName, CommandInput>;
  } catch {
    throw new Error("Expected one JSON request body.");
  }
}

function defaultTimeoutMessage(command: string) {
  return `Timed out waiting for the session to handle ${command}.`;
}

/**
 * Runtime-neutral daemon engine that owns broker lifecycle, health, stale pruning, and raw HTTP
 * plus websocket message handling without choosing Bun, Node, or any other server implementation.
 */
export class SessionBrokerDaemon<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  readonly paths: SessionBrokerHttpPaths;
  readonly stopped: Promise<void>;

  private readonly startedAt = Date.now();
  private readonly capabilities: SessionBrokerCapabilities;
  private readonly idleTimeoutMs: number;
  private readonly staleSessionTtlMs: number;
  private readonly staleSessionSweepIntervalMs: number;
  private lastActivityAt = this.startedAt;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private resolveStopped: (() => void) | null = null;

  constructor(
    private readonly broker: SessionBroker<Info, State, ServerMessage, CommandResult>,
    options: Omit<
      SessionBrokerDaemonOptions<Info, State, ServerMessage, CommandResult>,
      "broker"
    > = {},
  ) {
    this.paths = {
      health: options.paths?.health ?? DEFAULT_SESSION_BROKER_HEALTH_PATH,
      api: options.paths?.api ?? DEFAULT_SESSION_BROKER_API_PATH,
      capabilities: options.paths?.capabilities ?? DEFAULT_SESSION_BROKER_CAPABILITIES_PATH,
      socket: options.paths?.socket ?? DEFAULT_SESSION_BROKER_SOCKET_PATH,
    };
    this.capabilities = options.capabilities ?? { version: 1 };
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.staleSessionTtlMs = options.staleSessionTtlMs ?? DEFAULT_STALE_SESSION_TTL_MS;
    this.staleSessionSweepIntervalMs =
      options.staleSessionSweepIntervalMs ?? DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS;
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });

    this.startLifecycle();
  }

  listSessions() {
    return this.broker.listSessions();
  }

  getSession(
    selector: Parameters<SessionBroker<Info, State, ServerMessage, CommandResult>["getSession"]>[0],
  ) {
    return this.broker.getSession(selector);
  }

  getHealth(): SessionBrokerHealth {
    return {
      ok: true,
      pid: process.pid,
      sessions: this.broker.getSessionCount(),
      pendingCommands: this.broker.getPendingCommandCount(),
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      staleSessionTtlMs: this.staleSessionTtlMs,
      paths: this.paths,
    };
  }

  matchesSocketPath(pathname: string) {
    return pathname === this.paths.socket;
  }

  async handleRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === this.paths.health) {
      const removed = this.broker.pruneStaleSessions({ ttlMs: this.staleSessionTtlMs });
      if (removed > 0) {
        this.noteActivity();
      }

      return Response.json(this.getHealth());
    }

    if (url.pathname === this.paths.capabilities) {
      this.noteActivity();
      return Response.json(this.capabilities);
    }

    if (url.pathname === this.paths.api) {
      this.noteActivity();
      return this.handleApiRequest(request);
    }

    return null;
  }

  handleConnectionMessage(connection: SessionBrokerPeer, message: string) {
    const parsed = parseSocketEnvelope(message);
    if (!parsed) {
      return;
    }

    switch (parsed.type) {
      case "register": {
        if (!this.broker.registerSession(connection, parsed.registration, parsed.snapshot)) {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Incompatible session registration.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "snapshot": {
        if (typeof parsed.sessionId !== "string") {
          return;
        }

        const updateResult = this.broker.updateSnapshot(parsed.sessionId, parsed.snapshot);
        if (updateResult === "not-found") {
          connection.close?.(
            INCOMPATIBLE_PAYLOAD_CLOSE_CODE,
            "Session not registered with broker.",
          );
          return;
        }

        if (updateResult === "invalid") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Incompatible session snapshot.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "heartbeat": {
        if (typeof parsed.sessionId !== "string") {
          return;
        }

        this.broker.markSessionSeen(parsed.sessionId);
        this.noteActivity();
        break;
      }
      case "command-result": {
        if (typeof parsed.requestId !== "string" || typeof parsed.ok !== "boolean") {
          return;
        }

        this.broker.handleCommandResult({
          requestId: parsed.requestId,
          ok: parsed.ok,
          result: parsed.result as CommandResult | undefined,
          error: typeof parsed.error === "string" ? parsed.error : undefined,
        });
        this.noteActivity();
        break;
      }
    }
  }

  handleConnectionClose(connection: SessionBrokerPeer) {
    this.broker.unregisterConnection(connection);
    this.noteActivity();
  }

  shutdown(error = new Error("The session broker daemon shut down.")) {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.broker.shutdown(error);
    this.resolveStopped?.();
    this.resolveStopped = null;
  }

  private startLifecycle() {
    this.sweepTimer = setInterval(() => {
      const removed = this.broker.pruneStaleSessions({ ttlMs: this.staleSessionTtlMs });
      if (removed > 0) {
        this.noteActivity();
      }
    }, this.staleSessionSweepIntervalMs);

    this.sweepTimer.unref?.();
    this.refreshIdleTimer();
  }

  private hasActiveWork() {
    return this.broker.getSessionCount() > 0 || this.broker.getPendingCommandCount() > 0;
  }

  private noteActivity() {
    this.lastActivityAt = Date.now();
    this.refreshIdleTimer();
  }

  private refreshIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.shuttingDown || this.idleTimeoutMs <= 0 || this.hasActiveWork()) {
      return;
    }

    const idleForMs = Date.now() - this.lastActivityAt;
    const remainingMs = Math.max(0, this.idleTimeoutMs - idleForMs);

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      if (this.shuttingDown || this.hasActiveWork()) {
        return;
      }

      if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) {
        this.refreshIdleTimer();
        return;
      }

      this.shutdown();
    }, remainingMs);

    this.idleTimer.unref?.();
  }

  private async handleApiRequest(request: Request) {
    if (request.method !== "POST") {
      return jsonError("Broker API requests must use POST.", 405);
    }

    try {
      const input = await parseJsonRequest<ServerMessage["command"]>(request);
      let response: SessionBrokerDaemonResponse<Info, State, CommandResult>;

      switch (input.action) {
        case "list":
          response = { sessions: this.broker.listSessions() };
          break;
        case "get":
          response = { session: this.broker.getSession(input.selector) };
          break;
        case "dispatch":
          response = {
            result: await this.broker.dispatchCommand<CommandResult, ServerMessage["command"]>({
              selector: input.selector,
              command: input.command,
              input: input.input as Extract<
                ServerMessage,
                { command: ServerMessage["command"] }
              >["input"],
              timeoutMessage: input.timeoutMessage ?? defaultTimeoutMessage(input.command),
              timeoutMs: input.timeoutMs,
            }),
          };
          break;
        default:
          throw new Error("Unknown broker API action.");
      }

      return Response.json(response);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Unknown broker API error.");
    }
  }
}

/** Create one runtime-neutral broker daemon engine around an existing session broker. */
export function createSessionBrokerDaemon<
  Info = unknown,
  State = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
>(options: SessionBrokerDaemonOptions<Info, State, ServerMessage, CommandResult>) {
  return new SessionBrokerDaemon(options.broker, options);
}

export type SessionBrokerSession<Info = unknown, State = unknown> = SessionBrokerRecord<
  Info,
  State
>;
