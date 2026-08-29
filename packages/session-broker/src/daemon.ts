import {
  BrokerCapacityError,
  BrokerProtocolError,
  InvalidContentLengthError,
  PayloadTooLargeError,
  ResourceBudget,
  readRequestBytesWithReservation,
  mergeSessionBrokerLimits,
  DEFAULT_SESSION_BROKER_LIMITS,
  callerPrincipalAllows,
  canonicalizeJson,
  isValidBrokerAppId,
  isValidBrokerIdentifier,
  isValidBrokerRevision,
  utf8ByteLength,
  type BudgetReservation,
  type CallerOperation,
  type CallerPrincipal,
  type CanonicalJsonValue,
  type SessionBrokerLimitOptions,
  type SessionBrokerLimits,
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
  parseSessionBrokerJsonBytes,
  parseSessionBrokerJsonText,
  type SessionBrokerProtocolParsers,
} from "./protocolParsers";
import {
  DEFAULT_SESSION_BROKER_API_PATH,
  DEFAULT_SESSION_BROKER_CAPABILITIES_PATH,
  DEFAULT_SESSION_BROKER_HEALTH_PATH,
  DEFAULT_SESSION_BROKER_SOCKET_PATH,
  type SessionBrokerCapabilities,
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
const BROKER_STATE_LIMITS = [
  "maxSessions",
  "maxCommandsPerSession",
  "maxCommandsTotal",
  "maxCommandInputBytes",
  "maxCommandResultBytes",
  "maxQueuedCommandBytes",
  "maxRetainedSessionBytes",
  "maxRetainedBytes",
  "defaultCommandTimeoutMs",
  "maxCommandTimeoutMs",
] as const satisfies readonly (keyof SessionBrokerLimits)[];

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
  limits?: SessionBrokerLimitOptions["limits"];
  unsafeLimits?: SessionBrokerLimitOptions["unsafeLimits"];
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/** Map resource admission failures to stable retryable HTTP errors. */
function capacityResponse(error: BrokerCapacityError) {
  return Response.json({ error: error.code, resource: error.resource }, { status: 503 });
}

/** Build one redacted protocol failure body without reflecting parser details. */
function protocolError(error: unknown) {
  return {
    error: "protocol-validation-failed",
    code: error instanceof BrokerProtocolError ? error.code : "invalid-app-payload",
  } as const;
}

/** Return whether one raw broker API request body was explicitly sent as JSON. */
function hasJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
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

  readonly limits: Readonly<SessionBrokerLimits>;

  private readonly startedAt = Date.now();
  private readonly capabilities: SessionBrokerCapabilities;
  private readonly protocolParsers: SessionBrokerProtocolParsers<
    unknown,
    unknown,
    ServerMessage,
    CommandResult
  >;
  private readonly idleTimeoutMs: number;
  private readonly staleSessionTtlMs: number;
  private readonly staleSessionSweepIntervalMs: number;
  private readonly appId: string;
  private readonly appRevision?: number;
  private readonly callerAuthenticator?: CallerRequestAuthenticator;
  private readonly authorizer?: SessionBrokerAuthorizer;
  private readonly audit?: SessionBrokerAuditHook;
  private readonly httpControlBudget: ResourceBudget;
  private readonly httpBodyBudget: ResourceBudget;
  private lastActivityAt = this.startedAt;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private resolveStopped: (() => void) | null = null;

  constructor(
    private readonly broker: SessionBrokerController<SessionView, ServerMessage, CommandResult>,
    options: Omit<SessionBrokerDaemonOptions<SessionView, ServerMessage, CommandResult>, "broker">,
  ) {
    const brokerLimits = broker.limits ?? DEFAULT_SESSION_BROKER_LIMITS;
    this.limits = mergeSessionBrokerLimits(brokerLimits, {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.unsafeLimits ? { unsafeLimits: options.unsafeLimits } : {}),
    });
    if (BROKER_STATE_LIMITS.some((name) => this.limits[name] !== brokerLimits[name])) {
      throw new TypeError(
        "Session broker state limits must be configured on the broker controller before daemon composition.",
      );
    }
    this.httpControlBudget = new ResourceBudget(
      this.limits.maxConcurrentHttpControls,
      "maxConcurrentHttpControls",
      "busy",
    );
    this.httpBodyBudget = new ResourceBudget(
      this.limits.maxInFlightHttpBodyBytes,
      "maxInFlightHttpBodyBytes",
    );
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
    this.protocolParsers = broker.protocolParsers;
    if (
      options.appRevision !== undefined &&
      options.appRevision !== this.protocolParsers.appRevision
    ) {
      throw new TypeError("Session broker app revision does not match its parser registry.");
    }
    this.appId = options.appId ?? "session-broker";
    this.appRevision = this.protocolParsers.appRevision;
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

  /** Run one app-specific finite HTTP control through the daemon's shared count/body budgets. */
  async handleBoundedControl(
    request: Request,
    handler: (body: Uint8Array) => Response | Promise<Response>,
    responses: { payloadTooLarge?: (error: PayloadTooLargeError) => Response } = {},
  ): Promise<Response> {
    let control: BudgetReservation;
    try {
      control = this.httpControlBudget.reserve();
    } catch (error) {
      return capacityResponse(error as BrokerCapacityError);
    }
    let bodyReservation: BudgetReservation | null = null;
    try {
      try {
        const read = await readRequestBytesWithReservation(
          request,
          this.limits.maxHttpBodyBytes,
          this.httpBodyBudget,
        );
        bodyReservation = read.reservation;
        return await handler(read.bytes);
      } catch (error) {
        if (error instanceof BrokerCapacityError) return capacityResponse(error);
        if (error instanceof PayloadTooLargeError) {
          if (responses.payloadTooLarge) return responses.payloadTooLarge(error);
          return Response.json(
            { error: "capacity-exceeded", resource: "maxHttpBodyBytes" },
            { status: 413 },
          );
        }
        if (error instanceof InvalidContentLengthError) return jsonError("Invalid Content-Length.");
        return jsonError("Could not read broker control request body.");
      }
    } finally {
      bodyReservation?.release();
      control.release();
    }
  }

  async handleRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === this.paths.health) {
      // Treat health checks as a cheap maintenance pulse so stale sessions disappear even when the
      // daemon is mostly idle and no websocket traffic is flowing.
      const removed = this.broker.pruneStaleSessions({
        ttlMs: this.staleSessionTtlMs,
      });
      if (removed > 0) {
        this.noteActivity();
      }

      // Public health is deliberately liveness-only. Apps may expose authenticated diagnostics on
      // a separate route, but broker identity, paths, counts, and process facts stay private.
      return Response.json({ ok: true });
    }

    if (this.paths.capabilities && url.pathname === this.paths.capabilities) {
      return this.handleCapabilitiesRequest(request);
    }

    if (this.paths.api && url.pathname === this.paths.api) {
      this.noteActivity();
      return this.handleApiRequest(request);
    }

    return null;
  }

  handleConnectionMessage(connection: SessionBrokerPeer, message: unknown) {
    let parsed;
    try {
      parsed = this.protocolParsers.parseClientMessage(parseSessionBrokerJsonText(message));
    } catch {
      connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Malformed session broker protocol.");
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
        if (registrationResult === "capacity-exceeded") {
          connection.close?.(1013, "Session broker capacity exceeded.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "snapshot": {
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
        if (updateResult === "capacity-exceeded") {
          connection.close?.(1013, "Session broker capacity exceeded.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "heartbeat": {
        const seenResult = this.broker.markSessionSeen(connection, parsed.sessionId);
        if (seenResult === "not-owner") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Session ownership rejected.");
          return;
        }

        this.noteActivity();
        break;
      }
      case "command-result": {
        const result = this.broker.handleCommandResult(connection, parsed);
        if (result === "not-owner") {
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Command ownership rejected.");
          return;
        }

        if (result === "invalid") {
          // A result that violates the pending command contract invalidates the producer's current
          // assumptions. The broker keeps pending state coherent until disconnect cleanup runs.
          connection.close?.(INCOMPATIBLE_PAYLOAD_CLOSE_CODE, "Malformed command result.");
          return;
        }

        if (result === "handled") this.noteActivity();
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
    this.callerAuthenticator?.clear?.();
    this.resolveStopped?.();
    this.resolveStopped = null;
  }

  private startLifecycle() {
    this.sweepTimer = setInterval(() => {
      const removed = this.broker.pruneStaleSessions({
        ttlMs: this.staleSessionTtlMs,
      });
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
      const authenticated = await this.callerAuthenticator.authenticate({
        request,
        body,
      });
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
    const allowedByGrant = callerPrincipalAllows(principal, {
      appId: this.appId,
      ...facts,
    });
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
    let structuredBody = JSON.parse(JSON.stringify(body)) as CanonicalJsonValue;
    let responseStatus = status;
    const targetContract =
      targetSpecific && this.appRevision !== undefined
        ? { appContract: { appRevision: this.appRevision, features: [] as const } }
        : {};
    if (utf8ByteLength(canonicalizeJson(structuredBody)) > this.limits.maxHttpResponseBytes) {
      structuredBody = { error: "capacity-exceeded", resource: "maxHttpResponseBytes" };
      responseStatus = 503;
    }
    const authentication = await authenticated.signResponse({
      httpStatus: responseStatus,
      body: structuredBody,
      ...targetContract,
    });
    let envelope: SessionBrokerAuthenticatedResponse = {
      body: structuredBody,
      authentication,
    };
    let serializedEnvelope = canonicalizeJson(envelope as unknown as CanonicalJsonValue);
    if (utf8ByteLength(serializedEnvelope) > this.limits.maxHttpResponseBytes) {
      structuredBody = { error: "capacity-exceeded", resource: "maxHttpResponseBytes" };
      responseStatus = 503;
      envelope = {
        body: structuredBody,
        authentication: await authenticated.signResponse({
          httpStatus: responseStatus,
          body: structuredBody,
          ...targetContract,
        }),
      };
      serializedEnvelope = canonicalizeJson(envelope as unknown as CanonicalJsonValue);
    }
    if (utf8ByteLength(serializedEnvelope) > this.limits.maxHttpResponseBytes) {
      return new Response(null, { status: 503 });
    }
    return new Response(serializedEnvelope, {
      status: responseStatus,
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

  /** Run one authenticated capabilities control under the shared HTTP budgets. */
  private async handleCapabilitiesRequest(request: Request): Promise<Response> {
    let control: BudgetReservation;
    try {
      control = this.httpControlBudget.reserve();
    } catch (error) {
      return capacityResponse(error as BrokerCapacityError);
    }
    let bodyReservation: BudgetReservation | null = null;
    try {
      if (request.method !== "GET") {
        return jsonError("Broker capabilities requests must use GET.", 405);
      }
      let body: Uint8Array;
      try {
        const read = await readRequestBytesWithReservation(
          request,
          this.limits.maxHttpBodyBytes,
          this.httpBodyBudget,
        );
        body = read.bytes;
        bodyReservation = read.reservation;
      } catch (error) {
        if (error instanceof BrokerCapacityError) return capacityResponse(error);
        return error instanceof PayloadTooLargeError
          ? Response.json(
              { error: "capacity-exceeded", resource: "maxHttpBodyBytes" },
              { status: 413 },
            )
          : error instanceof InvalidContentLengthError
            ? jsonError("Invalid Content-Length.")
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
    } finally {
      bodyReservation?.release();
      control.release();
    }
  }

  private async handleApiRequest(request: Request) {
    let control: BudgetReservation;
    try {
      control = this.httpControlBudget.reserve();
    } catch (error) {
      return capacityResponse(error as BrokerCapacityError);
    }
    let bodyReservation: BudgetReservation | null = null;
    try {
      if (request.method !== "POST") {
        return jsonError("Broker API requests must use POST.", 405);
      }
      if (!hasJsonContentType(request)) {
        return jsonError("Expected Content-Type application/json.", 415);
      }

      let body: Uint8Array;
      try {
        const read = await readRequestBytesWithReservation(
          request,
          this.limits.maxHttpBodyBytes,
          this.httpBodyBudget,
        );
        body = read.bytes;
        bodyReservation = read.reservation;
      } catch (error) {
        if (error instanceof BrokerCapacityError) return capacityResponse(error);
        return error instanceof PayloadTooLargeError
          ? Response.json(
              { error: "capacity-exceeded", resource: "maxHttpBodyBytes" },
              { status: 413 },
            )
          : error instanceof InvalidContentLengthError
            ? jsonError("Invalid Content-Length.")
            : jsonError("Could not read broker API request body.");
      }

      // Authenticate the exact transport bytes before decoding or interpreting attacker-controlled JSON.
      const authenticated = await this.authenticateRequest(request, body, "list");
      if (authenticated instanceof Response) return authenticated;

      let input;
      try {
        input = this.protocolParsers.parseDaemonRequest(parseSessionBrokerJsonBytes(body));
      } catch (error) {
        return this.authenticatedResponse(authenticated, protocolError(error), 400);
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
          case "dispatch": {
            // Resolve the target before invoking app-owned parsing so the exact target contract is
            // selected first. This read-only lookup happens only after authentication/authorization.
            this.broker.getSession(input.selector);
            response = {
              result: await this.broker.dispatchCommand({
                selector: input.selector,
                command: input.command,
                commandVersion: input.commandVersion ?? 1,
                input: input.input,
                timeoutMessage: input.timeoutMessage ?? defaultTimeoutMessage(input.command),
                timeoutMs: input.timeoutMs,
              }),
            };
            break;
          }
        }
        return this.authenticatedResponse(authenticated, response, 200, targetSpecific);
      } catch (error) {
        return this.authenticatedResponse(
          authenticated,
          error instanceof BrokerCapacityError
            ? { error: error.code, resource: error.resource }
            : error instanceof BrokerProtocolError
              ? protocolError(error)
              : {
                  error: error instanceof Error ? error.message : "Unknown broker API error.",
                },
          error instanceof BrokerCapacityError ? 503 : 400,
          targetSpecific,
        );
      }
    } finally {
      bodyReservation?.release();
      control.release();
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
