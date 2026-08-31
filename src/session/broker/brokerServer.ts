import {
  SessionBrokerAuthenticator,
  createSessionBrokerDaemon,
  type SessionBrokerAuthenticatedControlFacts,
  type SessionBrokerController,
} from "@hunk/session-broker";
import {
  serveSessionBrokerDaemon as serveSessionBrokerDaemonWithBun,
  type RunningSessionBrokerDaemon as RunningBunSessionBrokerDaemon,
} from "@hunk/session-broker-bun";
import {
  LEGACY_MCP_PATH,
  SESSION_BROKER_SOCKET_PATH,
  allowsUnsafeRemoteSessionBroker,
  isLoopbackHost,
  resolveSessionBrokerConfig,
} from "./brokerConfig";
import { BrowserReviewServer } from "./browserReviewServer";
import { createHunkSessionBrokerState, type HunkSessionBrokerState } from "./state";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
} from "../types";
import {
  BrokerCapacityError,
  MAX_HTTP_BODY_BYTES,
  PayloadTooLargeError,
  readRequestBytesWithLimit,
} from "@hunk/session-broker-core";
import { listHunkSessionNotes } from "./projections";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
  type SessionDaemonResponse,
} from "../protocol";
import { MAX_HUNK_REVIEW_ENVELOPE_BYTES } from "../reviewProtocol";
import { parseSessionDaemonRequest } from "../protocolSchemas";
import { hunkSessionProtocolParsers } from "./protocolParsers";
import { loadOrCreateHunkSessionBrokerCredentials } from "./credentials";
import { HUNK_SESSION_BROKER_APP_ID, HUNK_SESSION_BROKER_APP_REVISION } from "./appContract";

const DEFAULT_STALE_SESSION_TTL_MS = 45_000;
const DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const SUPPORTED_SESSION_ACTIONS: SessionDaemonAction[] = [
  "list",
  "get",
  "context",
  "review",
  "navigate",
  "reload",
  "comment-add",
  "comment-apply",
  "comment-list",
  "comment-rm",
  "comment-clear",
  "highlight-add",
  "highlight-clear",
];

export interface ServeSessionBrokerDaemonOptions {
  idleTimeoutMs?: number;
  staleSessionTtlMs?: number;
  staleSessionSweepIntervalMs?: number;
}

export type RunningSessionBrokerDaemon = RunningBunSessionBrokerDaemon;

/**
 * Exported for unit testing.
 *
 * The helpers below (request validation, Host/Origin parsing, and the session API dispatcher)
 * carry the broker's DNS-rebinding defenses and action routing. They are pure functions over a
 * `Request`/state pair, so they are tested directly rather than only through a live HTTP server.
 */
export function formatDaemonServeError(error: unknown, host: string, port: number) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("eaddrinuse") ||
    normalized.includes("address already in use") ||
    normalized.includes(`is port ${port} in use?`)
  ) {
    return new Error(
      `Session broker daemon could not bind ${host}:${port} because the port is already in use. ` +
        `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
    );
  }

  return new Error(`Failed to start the session broker daemon on ${host}:${port}: ${message}`);
}

function sessionCapabilities(): SessionDaemonCapabilities {
  return {
    version: HUNK_SESSION_API_VERSION,
    daemonVersion: HUNK_SESSION_DAEMON_VERSION,
    actions: SUPPORTED_SESSION_ACTIONS,
  };
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

/** Return whether one request body was explicitly sent as JSON. */
function hasJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Parse a Host-style value into hostname and optional port pieces. */
export function parseHostAndPort(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(",")) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    const closeBracketIndex = trimmed.indexOf("]");
    if (closeBracketIndex < 0) {
      return null;
    }

    const host = trimmed.slice(1, closeBracketIndex);
    const rest = trimmed.slice(closeBracketIndex + 1);
    if (!rest) {
      return { host, port: undefined };
    }

    if (!rest.startsWith(":")) {
      return null;
    }

    const rawPort = rest.slice(1);
    if (!/^[0-9]+$/.test(rawPort)) return null;
    const port = Number(rawPort);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? { host, port } : null;
  }

  const colonCount = [...trimmed].filter((character) => character === ":").length;
  if (colonCount === 0) {
    return { host: trimmed, port: undefined };
  }

  if (colonCount === 1) {
    const [host, rawPort] = trimmed.split(":");
    if (!host || !/^[0-9]+$/.test(rawPort ?? "")) return null;
    const port = Number(rawPort);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? { host, port } : null;
  }

  // URL authorities require brackets around IPv6 literals; accepting another spelling would make
  // listener-derived authority comparison ambiguous.
  return null;
}

/** Return whether a parsed authority targets an accepted broker host and port. */
export function isAllowedHostPort(
  hostPort: { host: string; port?: number },
  expectedPort: number,
  options: { allowRemote: boolean },
) {
  const hostAllowed = options.allowRemote || isLoopbackHost(hostPort.host);
  const defaultHttpPort = 80;
  const port = hostPort.port ?? defaultHttpPort;
  return hostAllowed && port === expectedPort;
}

/** Block DNS-rebinding style requests whose Host does not name a permitted broker endpoint. */
export function validateHostHeader(request: Request, expectedPort: number, allowRemote: boolean) {
  const hostHeader = request.headers.get("host");
  if (!hostHeader) {
    return jsonError("Expected Host header for the local session broker.", 400);
  }

  const hostPort = parseHostAndPort(hostHeader);
  if (!hostPort || !isAllowedHostPort(hostPort, expectedPort, { allowRemote })) {
    return jsonError("Host header is not allowed for the local session broker.", 403);
  }

  return null;
}

/** Block browser-originated requests from non-local or wrong-port origins. */
export function validateOriginHeader(request: Request, expectedPort: number, allowRemote: boolean) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }
  if (origin === "null" || origin.includes(",")) {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== origin
  ) {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  const defaultPort = url.protocol === "http:" ? 80 : 443;
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;
  if (!isAllowedHostPort({ host: url.hostname, port }, expectedPort, { allowRemote })) {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  return null;
}

function parseJsonRequestBytes(bytes: Uint8Array) {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Expected one JSON request body.");
  }

  return parseSessionDaemonRequest(raw);
}

/** Resolve one daemon navigation request into the canonical target sent to the live session. */
function resolveNavigateCommandInput(
  state: HunkSessionBrokerState,
  input: Extract<SessionDaemonRequest, { action: "navigate" }>,
): NavigateToHunkToolInput {
  if (input.commentId !== undefined) {
    const hasConflictingTarget =
      input.commentDirection !== undefined ||
      input.filePath !== undefined ||
      input.hunkNumber !== undefined ||
      input.side !== undefined ||
      input.line !== undefined;
    if (hasConflictingTarget) {
      throw new Error("navigate commentId cannot be combined with another navigation target.");
    }

    const comment = state
      .listComments(input.selector)
      .find((candidate) => candidate.commentId === input.commentId);
    if (!comment) {
      throw new Error(
        `No live comment with id "${input.commentId}" exists in the selected session.`,
      );
    }

    // Exact coordinates let the session reveal the annotated row and derive its containing hunk.
    return {
      ...input.selector,
      filePath: comment.filePath,
      side: comment.side,
      line: comment.line,
    };
  }

  if (
    !input.commentDirection &&
    input.hunkNumber === undefined &&
    (input.side === undefined || input.line === undefined)
  ) {
    throw new Error(
      "navigate requires commentId, commentDirection, hunkNumber, or both side and line.",
    );
  }

  // Exact coordinates take precedence so callers reveal the row rather than only its hunk.
  const hasExactLineTarget = input.side !== undefined && input.line !== undefined;
  return {
    ...input.selector,
    filePath: input.filePath,
    hunkIndex:
      input.hunkNumber !== undefined && !hasExactLineTarget ? input.hunkNumber - 1 : undefined,
    side: input.side,
    line: input.line,
    commentDirection: input.commentDirection,
  };
}

/** Map each Hunk action to the generic operation and exact producer command scope it requires. */
function sessionApiAuthorizationFacts(
  state: HunkSessionBrokerState,
  bytes: Uint8Array,
): SessionBrokerAuthenticatedControlFacts {
  const input = parseJsonRequestBytes(bytes);
  if (input.action === "list") return { operation: "list", targetSpecific: false };
  const sessionId = input.selector.sessionId ?? state.getSession(input.selector).sessionId;
  if (["get", "context", "review", "comment-list"].includes(input.action)) {
    return { operation: "get", sessionId, targetSpecific: true };
  }
  const commandByAction = {
    navigate: "navigate_to_hunk",
    reload: "reload_session",
    "comment-add": "comment",
    "comment-apply": "comment_batch",
    "comment-rm": "remove_comment",
    "comment-clear": "clear_comments",
    "highlight-add": "highlight",
    "highlight-clear": "clear_highlights",
  } as const;
  const command = commandByAction[input.action as keyof typeof commandByAction];
  if (!command) throw new Error("Unknown session API action.");
  return {
    operation: "dispatch",
    sessionId,
    command,
    commandVersion: 1,
    targetSpecific: true,
  };
}

export async function handleSessionApiRequest(
  state: HunkSessionBrokerState,
  request: Request,
  bodyBytes?: Uint8Array,
  resolvedSessionId?: string,
) {
  if (request.method !== "POST") {
    return jsonError("Session API requests must use POST.", 405);
  }

  if (!hasJsonContentType(request)) {
    return jsonError("Expected Content-Type application/json.", 415);
  }

  try {
    const parsedInput = parseJsonRequestBytes(
      bodyBytes ?? (await readRequestBytesWithLimit(request, MAX_HTTP_BODY_BYTES)),
    );
    const input: SessionDaemonRequest =
      resolvedSessionId && parsedInput.action !== "list"
        ? { ...parsedInput, selector: { sessionId: resolvedSessionId } }
        : parsedInput;
    let response: SessionDaemonResponse;

    switch (input.action) {
      case "list":
        response = { sessions: state.listSessions() };
        break;
      case "get":
        response = { session: state.getSession(input.selector) };
        break;
      case "context":
        response = { context: state.getSelectedContext(input.selector) };
        break;
      case "review": {
        // Patch bodies are read back from the publishing session as review resources, so
        // this is the one session action whose projection is asynchronous.
        response = {
          review: await state.getSessionReviewWithResources(input.selector, {
            includePatch: input.includePatch,
            includeNotes: input.includeNotes,
          }),
        };
        break;
      }
      case "navigate": {
        const commandInput = resolveNavigateCommandInput(state, input);
        response = {
          result: await state.dispatchCommand<NavigatedSelectionResult, "navigate_to_hunk">({
            selector: input.selector,
            command: "navigate_to_hunk",
            input: commandInput,
            timeoutMessage: "Timed out waiting for the session to navigate to the requested hunk.",
          }),
        };
        break;
      }
      case "reload":
        response = {
          result: await state.dispatchCommand<ReloadedSessionResult, "reload_session">({
            selector: input.selector,
            command: "reload_session",
            input: {
              ...input.selector,
              nextInput: input.nextInput,
              sourcePath: input.sourcePath,
            },
            timeoutMessage: "Timed out waiting for the session to reload the requested contents.",
            timeoutMs: 30_000,
          }),
        };
        break;
      case "comment-add":
        response = {
          result: await state.dispatchCommand<AppliedCommentResult, "comment">({
            selector: input.selector,
            command: "comment",
            input: {
              ...input.selector,
              filePath: input.filePath,
              side: input.side,
              line: input.line,
              summary: input.summary,
              rationale: input.rationale,
              markup: input.markup,
              author: input.author,
              reveal: input.reveal,
            },
            timeoutMessage: "Timed out waiting for the session to apply the comment.",
          }),
        };
        break;
      case "comment-apply":
        response = {
          result: await state.dispatchCommand<AppliedCommentBatchResult, "comment_batch">({
            selector: input.selector,
            command: "comment_batch",
            input: {
              ...input.selector,
              comments: input.comments.map((comment) => ({
                filePath: comment.filePath,
                hunkIndex: comment.hunkNumber !== undefined ? comment.hunkNumber - 1 : undefined,
                side: comment.side,
                line: comment.line,
                summary: comment.summary,
                rationale: comment.rationale,
                markup: comment.markup,
                author: comment.author,
              })),
              revealMode: input.revealMode,
            },
            timeoutMessage: "Timed out waiting for the session to apply the comment batch.",
            timeoutMs: 30_000,
          }),
        };
        break;
      case "comment-list":
        response =
          input.type && input.type !== "live"
            ? {
                comments: listHunkSessionNotes(state.getSession(input.selector), {
                  filePath: input.filePath,
                  source: input.type === "all" ? undefined : input.type,
                }),
              }
            : {
                comments: state.listComments(input.selector, { filePath: input.filePath }),
              };
        break;
      case "comment-rm":
        response = {
          result: await state.dispatchCommand<RemovedCommentResult, "remove_comment">({
            selector: input.selector,
            command: "remove_comment",
            input: {
              ...input.selector,
              commentId: input.commentId,
            },
            timeoutMessage: "Timed out waiting for the session to remove the requested comment.",
          }),
        };
        break;
      case "comment-clear":
        response = {
          result: await state.dispatchCommand<ClearedCommentsResult, "clear_comments">({
            selector: input.selector,
            command: "clear_comments",
            input: {
              ...input.selector,
              filePath: input.filePath,
              includeUser: input.includeUser,
            },
            timeoutMessage: "Timed out waiting for the session to clear the requested comments.",
          }),
        };
        break;
      case "highlight-add":
        response = {
          result: await state.dispatchCommand<AppliedHighlightResult, "highlight">({
            selector: input.selector,
            command: "highlight",
            input: {
              ...input.selector,
              filePath: input.filePath,
              side: input.side,
              line: input.line,
              start: input.start,
              end: input.end,
              tone: input.tone,
              reveal: input.reveal,
            },
            timeoutMessage: "Timed out waiting for the session to apply the highlight.",
          }),
        };
        break;
      case "highlight-clear":
        response = {
          result: await state.dispatchCommand<ClearedHighlightsResult, "clear_highlights">({
            selector: input.selector,
            command: "clear_highlights",
            input: {
              ...input.selector,
              filePath: input.filePath,
            },
            timeoutMessage: "Timed out waiting for the session to clear the requested highlights.",
          }),
        };
        break;
      default:
        throw new Error("Unknown session API action.");
    }

    return Response.json(response);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(error.message, 413);
    }
    if (error instanceof BrokerCapacityError) {
      return Response.json({ error: error.code, resource: error.resource }, { status: 503 });
    }

    return jsonError(error instanceof Error ? error.message : "Unknown session API error.");
  }
}

type ListedHunkSession = ReturnType<HunkSessionBrokerState["listSessions"]>[number];

/**
 * Adapt Hunk's richer broker state into the minimal shared controller surface expected by the
 * generic daemon package. Hunk-only review/context helpers stay above this boundary.
 */
function createHunkBrokerController(
  state: HunkSessionBrokerState,
): SessionBrokerController<ListedHunkSession, HunkSessionServerMessage, HunkSessionCommandResult> {
  return {
    protocolParsers: hunkSessionProtocolParsers,
    limits: state.limits,
    listSessions: () => state.listSessions(),
    getSession: (selector) => state.getSession(selector),
    resolveSessionId: (selector) => state.getSession(selector).sessionId,
    getSessionIds: () => state.listSessions().map((session) => session.sessionId),
    getSessionCount: () => state.getSessionCount(),
    getPendingCommandCount: () => state.getPendingCommandCount(),
    registerSession: (connection, registrationInput, snapshotInput, options) =>
      state.registerSession(connection, registrationInput, snapshotInput, options),
    updateSnapshot: (connection, sessionId, snapshotInput) =>
      state.updateSnapshot(connection, sessionId, snapshotInput),
    markSessionSeen: (connection, sessionId) => state.markSessionSeen(connection, sessionId),
    unregisterConnection: (connection) => state.unregisterSocket(connection),
    pruneStaleSessions: (options) => state.pruneStaleSessions(options),
    dispatchCommand: (options) =>
      state.dispatchCommand<HunkSessionCommandResult, HunkSessionServerMessage["command"]>(
        options as Parameters<HunkSessionBrokerState["dispatchCommand"]>[0],
      ),
    handleCommandResult: (connection, message) => state.handleCommandResult(connection, message),
    shutdown: (error) => state.shutdown(error),
  };
}

/** Serve the local session broker daemon and websocket broker transport. */
export async function serveSessionBrokerDaemon(
  options: ServeSessionBrokerDaemonOptions = {},
): Promise<RunningSessionBrokerDaemon> {
  const config = resolveSessionBrokerConfig();
  const allowRemote = allowsUnsafeRemoteSessionBroker();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const staleSessionTtlMs = options.staleSessionTtlMs ?? DEFAULT_STALE_SESSION_TTL_MS;
  const staleSessionSweepIntervalMs =
    options.staleSessionSweepIntervalMs ?? DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS;
  const state = createHunkSessionBrokerState();
  const credentials = await loadOrCreateHunkSessionBrokerCredentials();
  const generation = `h_${crypto.randomUUID().replaceAll("-", "")}_0`;
  const authenticator = new SessionBrokerAuthenticator({
    appId: HUNK_SESSION_BROKER_APP_ID,
    appRevision: HUNK_SESSION_BROKER_APP_REVISION,
    generation,
    daemonIdentity: credentials.daemonIdentity,
    credentials: [credentials.producer, credentials.caller],
    // A CLI process normally performs capabilities plus one action, then exits. Retire its caller
    // session quickly so repeated short-lived commands cannot fill the generic retained-session cap.
    callerSessionTtlMs: 30_000,
  });
  const daemon = createSessionBrokerDaemon({
    broker: createHunkBrokerController(state),
    capabilities: {
      version: HUNK_SESSION_DAEMON_VERSION,
      name: "hunk-session-broker",
      actions: SUPPORTED_SESSION_ACTIONS,
    },
    idleTimeoutMs,
    staleSessionTtlMs,
    staleSessionSweepIntervalMs,
    appId: HUNK_SESSION_BROKER_APP_ID,
    appRevision: HUNK_SESSION_BROKER_APP_REVISION,
    callerAuthenticator: authenticator,
    helloAuthenticator: authenticator,
    producerEndpoint: `${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`,
    authorizer: () => true,
    // Hunk currently keeps audit decisions in-process; the generic hook guarantees only redacted
    // principal/operation metadata can be wired to a future diagnostic sink.
    audit: () => undefined,
    paths: {
      socket: SESSION_BROKER_SOCKET_PATH,
    },
  });
  // One loopback process serves every attached review, rather than a port per terminal. Authorized
  // review actions join the daemon's shared finite-control and aggregate body budgets.
  const browserReview = new BrowserReviewServer(state, {
    handleActionControl: (request, handler, payloadTooLarge) =>
      daemon.handleBoundedControl(request, handler, {
        maxBodyBytes: Math.min(MAX_HUNK_REVIEW_ENVELOPE_BYTES, MAX_HTTP_BODY_BYTES),
        payloadTooLarge,
      }),
  });

  const server = serveSessionBrokerDaemonWithBun({
    daemon,
    hostname: config.host,
    port: config.port,
    formatServeError: (error, _address) => formatDaemonServeError(error, config.host, config.port),
    handleRequest: async (request) => {
      const hostError = validateHostHeader(request, config.port, allowRemote);
      if (hostError) {
        return hostError;
      }

      const originError = validateOriginHeader(request, config.port, allowRemote);
      if (originError) {
        return originError;
      }

      const url = new URL(request.url);

      if (
        (url.pathname === HUNK_SESSION_CAPABILITIES_PATH ||
          url.pathname === HUNK_SESSION_API_PATH) &&
        !request.headers.has("x-session-broker-caller-session")
      ) {
        return Response.json(
          {
            error: "authentication-required",
            message:
              "This Hunk session client must be upgraded to use automatic signed authentication.",
          },
          { status: 401 },
        );
      }

      if (url.pathname === HUNK_SESSION_CAPABILITIES_PATH) {
        return daemon.handleAuthenticatedControl(request, {
          authenticationFailureOperation: "diagnostics",
          resolve: () => ({ operation: "diagnostics", targetSpecific: false }),
          handle: (body) =>
            request.method === "GET" && body.byteLength === 0
              ? { body: sessionCapabilities() as never }
              : {
                  body: { error: "Capabilities require GET with an empty body." },
                  status: request.method === "GET" ? 400 : 405,
                },
        });
      }

      // Keep Hunk action parsing and lowering app-owned while the generic hook authenticates,
      // authorizes, budgets, and signs the exact transport body and response.
      if (url.pathname === HUNK_SESSION_API_PATH) {
        return daemon.handleAuthenticatedControl(request, {
          resolve: (body) => sessionApiAuthorizationFacts(state, body),
          resolveFailureTargetSpecific: (body) => parseJsonRequestBytes(body).action !== "list",
          handle: async (body, facts) => {
            const response = await handleSessionApiRequest(state, request, body, facts.sessionId);
            return { body: (await response.json()) as never, status: response.status };
          },
        });
      }

      // The review surface authorizes every one of its own routes with a per-session
      // capability, so it is mounted after the daemon's host/origin checks and before the
      // legacy tombstone; it declines anything that is not a review route.
      const review = await browserReview.handle(request);
      if (review) {
        return review;
      }

      if (url.pathname === LEGACY_MCP_PATH) {
        // Preserve an explicit tombstone for the removed MCP route so stale automation gets a clear
        // upgrade message instead of a generic 404.
        return jsonError(
          "This app no longer exposes agent-facing MCP tools. Use the session CLI instead.",
          410,
        );
      }

      return undefined;
    },
  });

  const shutdown = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    browserReview.close();
    server.stop(true);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void server.stopped.finally(() => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });

  console.log(`Session broker API listening on ${config.httpOrigin}${HUNK_SESSION_API_PATH}`);
  console.log(
    `Session broker websocket listening on ${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`,
  );

  return server;
}
