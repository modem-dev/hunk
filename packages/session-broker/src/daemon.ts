import {
  MAX_HTTP_BODY_BYTES,
  PayloadTooLargeError,
  callerPrincipalAllows,
  canonicalizeJson,
  isValidBrokerAppId,
  isValidBrokerIdentifier,
  isValidBrokerRevision,
  readRequestBytesWithLimit,
  type CallerOperation,
  type CallerPrincipal,
  type CanonicalJsonValue,
  type SessionServerMessage,
  type SessionTargetSelector,
} from "@hunk/session-broker-core";
import type { SessionBrokerController, SessionBrokerPeer } from "./broker";
import {
  SessionBrokerAuthenticationError,
  type AuthenticatedCallerRequest,
  type CallerRequestAuthenticator,
} from "./authentication";
import {
  DEFAULT_SESSION_BROKER_API_PATH,
  DEFAULT_SESSION_BROKER_CAPABILITIES_PATH,
  DEFAULT_SESSION_BROKER_HEALTH_PATH,
  DEFAULT_SESSION_BROKER_SOCKET_PATH,
  type SessionBrokerCapabilities,
  type SessionBrokerDaemonRequest,
  type SessionBrokerDaemonResponse,
  type SessionBrokerAuthenticatedResponse,
  type SessionBrokerAuditEvent,
  type SessionBrokerAuditHook,
  type SessionBrokerAuthorizer,
  type SessionBrokerHealth,
  type SessionBrokerHttpPaths,
} from "./types";

const DEFAULT_STALE_SESSION_TTL_MS = 45_000;
const DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const INCOMPATIBLE_PAYLOAD_CLOSE_CODE = 1008;

export interface SessionBrokerDaemonOptions<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
> {
  broker: SessionBrokerController<SessionView, ServerMessage, CommandResult>;
  capabilities?: SessionBrokerCapabilities;
  paths?: Partial<SessionBrokerHttpPaths>;
  exposeHttpApi?: boolean;
  callerAuthenticator?: CallerRequestAuthenticator;
  authorizer?: SessionBrokerAuthorizer;
  audit?: SessionBrokerAuditHook;
  appId?: string;
  appRevision?: number;
  idleTimeoutMs?: number;
  staleSessionTtlMs?: number;
  staleSessionSweepIntervalMs?: number;
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/** Parse one websocket envelope without committing the daemon to any runtime socket type. */
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

/** Return whether one raw broker API request body was explicitly sent as JSON. */
function hasJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Decode one raw broker API request body and surface a friendly transport-level error. */
function parseJsonRequest<CommandName extends string = string, CommandInput = unknown>(
  body: Uint8Array,
): SessionBrokerDaemonRequest<CommandName, CommandInput> {
  let parsed: unknown;
  try {
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
      throw new TypeError("UTF-8 BOM is not permitted.");
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("Expected one strictly encoded JSON request body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected one JSON request object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.action === "list") return { action: "list" };
  if (record.action !== "get" && record.action !== "dispatch") {
    throw new Error("Unknown broker API action.");
  }
  if (!record.selector || typeof record.selector !== "object" || Array.isArray(record.selector)) {
    throw new Error("Expected one broker session selector.");
  }
  const selector = record.selector as Record<string, unknown>;
  for (const key of ["sessionId", "sessionPath", "repoRoot", "repoBoundary"] as const) {
    if (selector[key] !== undefined && typeof selector[key] !== "string") {
      throw new Error("Expected one valid broker session selector.");
    }
  }
  if (selector.sessionId !== undefined && !isValidBrokerIdentifier(selector.sessionId)) {
    throw new Error("Expected one valid broker session identifier.");
  }
  if (record.action === "get") {
    return { action: "get", selector: selector as SessionTargetSelector };
  }
  if (!isValidBrokerIdentifier(record.command)) {
    throw new Error("Expected one valid broker command name.");
  }
  const commandVersion = record.commandVersion ?? 1;
  if (!isValidBrokerRevision(commandVersion)) {
    throw new Error("Expected one positive broker command version.");
  }
  if (
    record.timeoutMs !== undefined &&
    (!Number.isSafeInteger(record.timeoutMs) || (record.timeoutMs as number) <= 0)
  ) {
    throw new Error("Expected one positive command timeout.");
  }
  if (record.timeoutMessage !== undefined && typeof record.timeoutMessage !== "string") {
    throw new Error("Expected one command timeout message.");
  }
  return {
    action: "dispatch",
    selector: selector as SessionTargetSelector,
    command: record.command as CommandName,
    commandVersion,
    input: record.input as CommandInput,
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }),
    ...(record.timeoutMessage === undefined
      ? {}
      : { timeoutMessage: record.timeoutMessage as string }),
  };
}

/** Build the default dispatch timeout text so adapters can override only when they need to. */
function defaultTimeoutMessage(command: string) {
  return `Timed out waiting for the session to handle ${command}.`;
}

/**
 * Runtime-neutral daemon engine that owns broker lifecycle, health, stale pruning, and raw HTTP
 * plus websocket message handling without choosing Bun, Node, or any other server implementation.
 */
export class SessionBrokerDaemon<
  SessionView = unknown,
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
  private readonly appId: string;
  private readonly appRevision?: number;
  private readonly callerAuthenticator?: CallerRequestAuthenticator;
  private readonly authorizer?: SessionBrokerAuthorizer;
  private readonly audit?: SessionBrokerAuditHook;
  private lastActivityAt = this.startedAt;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private resolveStopped: (() => void) | null = null;

  constructor(
    private readonly broker: SessionBrokerController<SessionView, ServerMessage, CommandResult>,
    options: Omit<
      SessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>,
      "broker"
    > = {},
  ) {
    const exposeAuthenticatedHttpApi =
      (options.exposeHttpApi ?? false) &&
      isValidBrokerAppId(options.appId) &&
      isValidBrokerRevision(options.appRevision) &&
      !!options.callerAuthenticator &&
      !!options.authorizer;
    this.paths = {
      health: options.paths?.health ?? DEFAULT_SESSION_BROKER_HEALTH_PATH,
      socket: options.paths?.socket ?? DEFAULT_SESSION_BROKER_SOCKET_PATH,
      api: exposeAuthenticatedHttpApi
        ? (options.paths?.api ?? DEFAULT_SESSION_BROKER_API_PATH)
        : undefined,
      capabilities: exposeAuthenticatedHttpApi
        ? (options.paths?.capabilities ?? DEFAULT_SESSION_BROKER_CAPABILITIES_PATH)
        : undefined,
    };
    this.capabilities = options.capabilities ?? { version: 1 };
    this.appId = options.appId ?? "session-broker";
    this.appRevision = options.appRevision;
    this.callerAuthenticator = options.callerAuthenticator;
    this.authorizer = options.authorizer;
    this.audit = options.audit;
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

  getSession(selector: SessionTargetSelector) {
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
      // Treat health checks as a cheap maintenance pulse so stale sessions disappear even when the
      // daemon is mostly idle and no websocket traffic is flowing.
      const removed = this.broker.pruneStaleSessions({ ttlMs: this.staleSessionTtlMs });
      if (removed > 0) {
        this.noteActivity();
      }

      // Public health is deliberately liveness-only. Apps may expose authenticated diagnostics on
      // a separate route, but broker identity, paths, counts, and process facts stay private.
      return Response.json({ ok: true });
    }

    if (this.paths.capabilities && url.pathname === this.paths.capabilities) {
      if (request.method !== "GET") {
        return jsonError("Broker capabilities requests must use GET.", 405);
      }
      let body: Uint8Array;
      try {
        body = await readRequestBytesWithLimit(request, MAX_HTTP_BODY_BYTES);
      } catch (error) {
        return error instanceof PayloadTooLargeError
          ? jsonError(error.message, 413)
          : jsonError("Could not read broker capabilities request body.");
      }
      if (body.byteLength !== 0) {
        return jsonError("Broker capabilities requests must not include a body.");
      }
      const authenticated = await this.authenticateRequest(request, body, "diagnostics");
      if (authenticated instanceof Response) return authenticated;
      if (!(await this.authorize(request, authenticated, { operation: "diagnostics" }))) {
        return this.authenticatedResponse(authenticated, { error: "authorization-denied" }, 403);
      }
      const inactive = this.rejectInactiveRequest(authenticated);
      if (inactive) return inactive;
      this.noteActivity();
      return this.authenticatedResponse(authenticated, this.capabilities, 200);
    }

    if (this.paths.api && url.pathname === this.paths.api) {
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
        const registrationResult = this.broker.registerSession(
          connection,
          parsed.registration,
          parsed.snapshot,
        );
        if (registrationResult === "invalid") {
          // Close immediately when the registration payload is incompatible so the session does not
          // stay connected under stale assumptions after an upgrade.
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Incompatible session registration.");
          return;
        }

        if (registrationResult === "already-connected") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Session registration rejected.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "snapshot": {
        if (typeof parsed.sessionId !== "string") {
          return;
        }

        // Snapshot updates are only valid after registration. Closing missing or invalid sessions
        // keeps the broker state single-sourced instead of guessing how to recover.
        const updateResult = this.broker.updateSnapshot(
          connection,
          parsed.sessionId,
          parsed.snapshot,
        );
        if (updateResult === "not-owner") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Session ownership rejected.");
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

        const seenResult = this.broker.markSessionSeen(connection, parsed.sessionId);
        if (seenResult === "not-owner") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Session ownership rejected.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "command-result": {
        if (typeof parsed.requestId !== "string" || typeof parsed.ok !== "boolean") {
          return;
        }

        const result = this.broker.handleCommandResult(connection, {
          requestId: parsed.requestId,
          ok: parsed.ok,
          result: parsed.result as CommandResult | undefined,
          error: typeof parsed.error === "string" ? parsed.error : undefined,
        });
        if (result === "not-owner") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Command ownership rejected.");
          return;
        }

        if (result === "handled") {
          this.noteActivity();
        }
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

    // Only arm idle shutdown when the daemon is truly quiescent. Any live session or in-flight
    // command keeps the process alive, even if no new HTTP requests arrive.
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

      // Re-check the wall clock when the timer fires because work may have happened after the
      // timer was scheduled but before it got a chance to run.
      if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) {
        this.refreshIdleTimer();
        return;
      }

      this.shutdown();
    }, remainingMs);
  }

  private async authenticateRequest(
    request: Request,
    body: Uint8Array,
    operation: CallerOperation,
  ): Promise<AuthenticatedCallerRequest | Response> {
    const requestId = request.headers.get("x-session-broker-request-id") ?? undefined;
    try {
      if (!this.callerAuthenticator || !this.authorizer) {
        return jsonError("Broker control is unavailable.", 404);
      }
      const authenticated = await this.callerAuthenticator.authenticate({ request, body });
      if (
        !authenticated ||
        typeof authenticated !== "object" ||
        !authenticated.principal ||
        !isValidBrokerIdentifier(authenticated.requestId) ||
        typeof authenticated.assertActive !== "function" ||
        typeof authenticated.signResponse !== "function"
      ) {
        throw new SessionBrokerAuthenticationError("invalid-credential");
      }
      return authenticated;
    } catch (error) {
      const code =
        error instanceof SessionBrokerAuthenticationError ? error.code : "authentication-required";
      await this.emitAudit({
        appId: this.appId,
        operation,
        ...(requestId !== undefined ? { requestId } : {}),
        decision: "deny",
        outcome: "authentication-failed",
        timestamp: Date.now(),
      });
      return Response.json({ error: "authentication-failed", code }, { status: 401 });
    }
  }

  /** Fail a request whose caller session changed while asynchronous app policy was running. */
  private rejectInactiveRequest(authenticated: AuthenticatedCallerRequest): Response | null {
    try {
      authenticated.assertActive();
      return null;
    } catch (error) {
      const code =
        error instanceof SessionBrokerAuthenticationError ? error.code : "authentication-required";
      return Response.json({ error: "authentication-failed", code }, { status: 401 });
    }
  }

  private async authorize(
    request: Request,
    authenticated: AuthenticatedCallerRequest,
    facts: {
      operation: CallerOperation;
      sessionId?: string;
      command?: string;
      commandVersion?: number;
    },
  ): Promise<boolean> {
    const principal: CallerPrincipal = authenticated.principal;
    const allowedByGrant = callerPrincipalAllows(principal, { appId: this.appId, ...facts });
    let allowedByApp = false;
    if (allowedByGrant && this.authorizer) {
      try {
        allowedByApp = await this.authorizer({
          principal,
          ...facts,
          requestId: authenticated.requestId,
          signal: request.signal,
        });
      } catch {
        // App policy errors fail closed and never expose callback details to the caller.
        allowedByApp = false;
      }
    }
    await this.emitAudit({
      appId: this.appId,
      principalId: principal.principalId,
      keyId: principal.keyId,
      ...(facts.sessionId !== undefined ? { sessionId: facts.sessionId } : {}),
      operation: facts.operation,
      ...(facts.command !== undefined ? { command: facts.command } : {}),
      ...(facts.commandVersion === undefined ? {} : { commandVersion: facts.commandVersion }),
      requestId: authenticated.requestId,
      decision: allowedByApp ? "allow" : "deny",
      outcome: allowedByApp ? "authenticated" : "authorization-failed",
      timestamp: Date.now(),
    });
    return allowedByApp;
  }

  private async authenticatedResponse(
    authenticated: AuthenticatedCallerRequest,
    body: unknown,
    status: number,
    targetSpecific = false,
  ): Promise<Response> {
    // Normalize with JSON semantics first so optional undefined fields cannot create digest aliases.
    const structuredBody = JSON.parse(JSON.stringify(body)) as CanonicalJsonValue;
    canonicalizeJson(structuredBody);
    const authentication = await authenticated.signResponse({
      httpStatus: status,
      body: structuredBody,
      ...(targetSpecific && this.appRevision !== undefined
        ? { appContract: { appRevision: this.appRevision, features: [] } }
        : {}),
    });
    const envelope: SessionBrokerAuthenticatedResponse = { body: structuredBody, authentication };
    return new Response(canonicalizeJson(envelope as unknown as CanonicalJsonValue), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private async emitAudit(event: SessionBrokerAuditEvent): Promise<void> {
    try {
      await this.audit?.(event);
    } catch {
      // Audit sinks observe decisions but cannot weaken them or leak their failures to callers.
    }
  }

  private async handleApiRequest(request: Request) {
    if (request.method !== "POST") {
      return jsonError("Broker API requests must use POST.", 405);
    }
    if (!hasJsonContentType(request)) {
      return jsonError("Expected Content-Type application/json.", 415);
    }

    let body: Uint8Array;
    try {
      body = await readRequestBytesWithLimit(request, MAX_HTTP_BODY_BYTES);
    } catch (error) {
      return error instanceof PayloadTooLargeError
        ? jsonError(error.message, 413)
        : jsonError("Could not read broker API request body.");
    }

    // Authenticate the exact transport bytes before decoding or interpreting attacker-controlled JSON.
    const authenticated = await this.authenticateRequest(request, body, "list");
    if (authenticated instanceof Response) return authenticated;

    let input: SessionBrokerDaemonRequest<ServerMessage["command"]>;
    try {
      input = parseJsonRequest<ServerMessage["command"]>(body);
    } catch (error) {
      return this.authenticatedResponse(
        authenticated,
        { error: error instanceof Error ? error.message : "Invalid broker API request." },
        400,
      );
    }

    const operation = input.action as CallerOperation;
    const selector = "selector" in input ? input.selector : undefined;
    const sessionId = selector?.sessionId;
    const command = input.action === "dispatch" ? input.command : undefined;
    const commandVersion = input.action === "dispatch" ? (input.commandVersion ?? 1) : undefined;
    const facts = {
      operation,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(command !== undefined ? { command, commandVersion } : {}),
    };
    const targetSpecific = input.action !== "list";
    if (!(await this.authorize(request, authenticated, facts))) {
      return this.authenticatedResponse(
        authenticated,
        { error: "authorization-denied" },
        403,
        targetSpecific,
      );
    }
    const inactive = this.rejectInactiveRequest(authenticated);
    if (inactive) return inactive;

    try {
      let response: SessionBrokerDaemonResponse<SessionView, CommandResult>;
      switch (input.action) {
        case "list":
          response = { sessions: this.broker.listSessions() };
          break;
        case "get":
          response = { session: this.broker.getSession(input.selector) };
          break;
        case "dispatch":
          response = {
            result: await this.broker.dispatchCommand({
              selector: input.selector,
              command: input.command,
              commandVersion: input.commandVersion ?? 1,
              input: input.input as Extract<
                ServerMessage,
                { command: ServerMessage["command"] }
              >["input"],
              timeoutMessage: input.timeoutMessage ?? defaultTimeoutMessage(input.command),
              timeoutMs: input.timeoutMs,
            }),
          };
          break;
      }
      return this.authenticatedResponse(authenticated, response, 200, targetSpecific);
    } catch (error) {
      return this.authenticatedResponse(
        authenticated,
        { error: error instanceof Error ? error.message : "Unknown broker API error." },
        400,
        targetSpecific,
      );
    }
  }
}

/** Create one runtime-neutral broker daemon engine around an existing session broker. */
export function createSessionBrokerDaemon<
  SessionView = unknown,
  ServerMessage extends SessionServerMessage = SessionServerMessage,
  CommandResult = unknown,
>(options: SessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>) {
  return new SessionBrokerDaemon(options.broker, options);
}

export type SessionBrokerSession<SessionView = unknown> = SessionView;
