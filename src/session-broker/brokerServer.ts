import { createSessionBrokerDaemon, type SessionBrokerController } from "@hunk/session-broker";
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
import {
  createHunkSessionBrokerState,
  type HunkSessionBrokerState,
} from "../hunk-session/brokerAdapter";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  HunkSessionCommandResult,
  HunkSessionServerMessage,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
} from "../hunk-session/types";
import {
  MAX_HTTP_BODY_BYTES,
  PayloadTooLargeError,
  readRequestTextWithLimit,
} from "@hunk/session-broker-core";
import { listHunkSessionNotes } from "../hunk-session/projections";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  HUNK_SESSION_DAEMON_VERSION,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
  type SessionDaemonResponse,
} from "../session/protocol";

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
  if (!trimmed) {
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

    const port = Number.parseInt(rest.slice(1), 10);
    return Number.isInteger(port) && port > 0 ? { host, port } : null;
  }

  const colonCount = [...trimmed].filter((character) => character === ":").length;
  if (colonCount === 0) {
    return { host: trimmed, port: undefined };
  }

  if (colonCount === 1) {
    const [host, rawPort] = trimmed.split(":");
    const port = Number.parseInt(rawPort ?? "", 10);
    return host && Number.isInteger(port) && port > 0 ? { host, port } : null;
  }

  // Unbracketed IPv6 literals are invalid in Host headers, but accepting the address without a
  // port keeps validation strict enough for DNS-rebinding while tolerating unusual native clients.
  return { host: trimmed, port: undefined };
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

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  const defaultPort = url.protocol === "http:" ? 80 : 443;
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;
  if (!isAllowedHostPort({ host: url.hostname, port }, expectedPort, { allowRemote })) {
    return jsonError("Origin is not allowed for the local session broker.", 403);
  }

  return null;
}

async function parseJsonRequest(request: Request) {
  const text = await readRequestTextWithLimit(request, MAX_HTTP_BODY_BYTES);
  try {
    return JSON.parse(text) as SessionDaemonRequest;
  } catch {
    throw new Error("Expected one JSON request body.");
  }
}

export async function handleSessionApiRequest(state: HunkSessionBrokerState, request: Request) {
  if (request.method !== "POST") {
    return jsonError("Session API requests must use POST.", 405);
  }

  if (!hasJsonContentType(request)) {
    return jsonError("Expected Content-Type application/json.", 415);
  }

  try {
    const input = await parseJsonRequest(request);
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
        response = {
          review: state.getSessionReview(input.selector, {
            includePatch: input.includePatch,
            includeNotes: input.includeNotes,
          }),
        };
        break;
      }
      case "navigate": {
        if (
          !input.commentDirection &&
          input.hunkNumber === undefined &&
          (input.side === undefined || input.line === undefined)
        ) {
          throw new Error("navigate requires either hunkNumber or both side and line.");
        }

        response = {
          result: await state.dispatchCommand<NavigatedSelectionResult, "navigate_to_hunk">({
            selector: input.selector,
            command: "navigate_to_hunk",
            input: {
              ...input.selector,
              filePath: input.filePath,
              hunkIndex: input.hunkNumber !== undefined ? input.hunkNumber - 1 : undefined,
              side: input.side,
              line: input.line,
              commentDirection: input.commentDirection,
            },
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
      case "comment-list": {
        const matchesAuthor = <T extends { author?: string }>(items: T[]): T[] =>
          input.author !== undefined
            ? items.filter((comment) => comment.author === input.author)
            : input.noAuthor
              ? items.filter((comment) => !comment.author)
              : items;
        response =
          input.type && input.type !== "live"
            ? {
                comments: matchesAuthor(
                  listHunkSessionNotes(state.getSession(input.selector), {
                    filePath: input.filePath,
                    source: input.type === "all" ? undefined : input.type,
                  }),
                ),
              }
            : {
                comments: matchesAuthor(
                  state.listComments(input.selector, { filePath: input.filePath }),
                ),
              };
        break;
      }
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
      default:
        throw new Error("Unknown session API action.");
    }

    return Response.json(response);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError(error.message, 413);
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
    listSessions: () => state.listSessions(),
    getSession: (selector) => state.getSession(selector),
    getSessionCount: () => state.getSessionCount(),
    getPendingCommandCount: () => state.getPendingCommandCount(),
    registerSession: (connection, registrationInput, snapshotInput) =>
      state.registerSession(connection, registrationInput, snapshotInput),
    updateSnapshot: (sessionId, snapshotInput) => state.updateSnapshot(sessionId, snapshotInput),
    markSessionSeen: (sessionId) => state.markSessionSeen(sessionId),
    unregisterConnection: (connection) => state.unregisterSocket(connection),
    pruneStaleSessions: (options) => state.pruneStaleSessions(options),
    dispatchCommand: (options) =>
      state.dispatchCommand<HunkSessionCommandResult, HunkSessionServerMessage["command"]>(
        options as Parameters<HunkSessionBrokerState["dispatchCommand"]>[0],
      ),
    handleCommandResult: (message) => state.handleCommandResult(message),
    shutdown: (error) => state.shutdown(error),
  };
}

/** Serve the local session broker daemon and websocket broker transport. */
export function serveSessionBrokerDaemon(
  options: ServeSessionBrokerDaemonOptions = {},
): RunningSessionBrokerDaemon {
  const config = resolveSessionBrokerConfig();
  const allowRemote = allowsUnsafeRemoteSessionBroker();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const staleSessionTtlMs = options.staleSessionTtlMs ?? DEFAULT_STALE_SESSION_TTL_MS;
  const staleSessionSweepIntervalMs =
    options.staleSessionSweepIntervalMs ?? DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS;
  const state = createHunkSessionBrokerState();
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
    paths: {
      socket: SESSION_BROKER_SOCKET_PATH,
    },
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

      if (url.pathname === "/health") {
        // Extend the generic health payload with the Hunk-specific companion endpoints that older
        // CLI clients and debugging workflows still expect to discover from one place.
        return Response.json({
          ...daemon.getHealth(),
          sessionApi: `${config.httpOrigin}${HUNK_SESSION_API_PATH}`,
          sessionCapabilities: `${config.httpOrigin}${HUNK_SESSION_CAPABILITIES_PATH}`,
          sessionSocket: `${config.wsOrigin}${SESSION_BROKER_SOCKET_PATH}`,
        });
      }

      if (url.pathname === HUNK_SESSION_CAPABILITIES_PATH) {
        return Response.json(sessionCapabilities());
      }

      // Keep the richer Hunk session API here rather than in the shared package so commands like
      // review, reload, and comment flows stay app-specific.
      if (url.pathname === HUNK_SESSION_API_PATH) {
        return handleSessionApiRequest(state, request);
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
