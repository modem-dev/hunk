import { createSessionBrokerDaemon, type SessionBrokerController } from "@hunk/session-broker";
import {
  serveSessionBrokerDaemon as serveSessionBrokerDaemonWithBun,
  type RunningSessionBrokerDaemon as RunningBunSessionBrokerDaemon,
} from "@hunk/session-broker-bun";
import {
  LEGACY_MCP_PATH,
  SESSION_BROKER_SOCKET_PATH,
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

function formatDaemonServeError(error: unknown, host: string, port: number) {
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

async function parseJsonRequest(request: Request) {
  try {
    return (await request.json()) as SessionDaemonRequest;
  } catch {
    throw new Error("Expected one JSON request body.");
  }
}

async function handleSessionApiRequest(state: HunkSessionBrokerState, request: Request) {
  if (request.method !== "POST") {
    return jsonError("Session API requests must use POST.", 405);
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
      case "review":
        response = {
          review: state.getSessionReview(input.selector, { includePatch: input.includePatch }),
        };
        break;
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
        response = {
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
    return jsonError(error instanceof Error ? error.message : "Unknown session API error.");
  }
}

type ListedHunkSession = ReturnType<HunkSessionBrokerState["listSessions"]>[number];

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
      const url = new URL(request.url);

      if (url.pathname === "/health") {
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

      if (url.pathname === HUNK_SESSION_API_PATH) {
        return handleSessionApiRequest(state, request);
      }

      if (url.pathname === LEGACY_MCP_PATH) {
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
