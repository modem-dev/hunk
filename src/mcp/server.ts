import { HUNK_SESSION_SOCKET_PATH, resolveHunkMcpConfig } from "./config";
import { HunkDaemonState } from "./daemonState";
import type { SessionClientMessage } from "./types";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
  type SessionDaemonResponse,
} from "../session/protocol";

const STALE_SESSION_TTL_MS = 45_000;
const STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;

const SUPPORTED_SESSION_ACTIONS: SessionDaemonAction[] = [
  "list",
  "get",
  "context",
  "navigate",
  "comment-add",
  "comment-list",
  "comment-rm",
  "comment-clear",
];

function formatDaemonServeError(error: unknown, host: string, port: number) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("eaddrinuse") ||
    normalized.includes("address already in use") ||
    normalized.includes(`is port ${port} in use?`)
  ) {
    return new Error(
      `Hunk MCP daemon could not bind ${host}:${port} because the port is already in use. ` +
        `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
    );
  }

  return new Error(`Failed to start the Hunk MCP daemon on ${host}:${port}: ${message}`);
}

function sessionCapabilities(): SessionDaemonCapabilities {
  return {
    version: HUNK_SESSION_API_VERSION,
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

async function handleSessionApiRequest(state: HunkDaemonState, request: Request) {
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
      case "navigate": {
        if (
          input.hunkNumber === undefined &&
          (input.side === undefined || input.line === undefined)
        ) {
          throw new Error("navigate requires either hunkNumber or both side and line.");
        }

        response = {
          result: await state.sendNavigateToHunk({
            ...input.selector,
            filePath: input.filePath,
            hunkIndex: input.hunkNumber !== undefined ? input.hunkNumber - 1 : undefined,
            side: input.side,
            line: input.line,
          }),
        };
        break;
      }
      case "comment-add":
        response = {
          result: await state.sendComment({
            ...input.selector,
            filePath: input.filePath,
            side: input.side,
            line: input.line,
            summary: input.summary,
            rationale: input.rationale,
            author: input.author,
            reveal: input.reveal,
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
          result: await state.sendRemoveComment({
            ...input.selector,
            commentId: input.commentId,
          }),
        };
        break;
      case "comment-clear":
        response = {
          result: await state.sendClearComments({
            ...input.selector,
            filePath: input.filePath,
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

/** Serve the local Hunk session daemon and websocket session broker. */
export function serveHunkMcpServer() {
  const config = resolveHunkMcpConfig();
  const state = new HunkDaemonState();
  const startedAt = Date.now();
  let shuttingDown = false;

  const sweepTimer = setInterval(() => {
    state.pruneStaleSessions({ ttlMs: STALE_SESSION_TTL_MS });
  }, STALE_SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  let server: ReturnType<typeof Bun.serve<{}>>;
  try {
    server = Bun.serve<{}>({
      hostname: config.host,
      port: config.port,
      fetch: async (request, bunServer) => {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          state.pruneStaleSessions({ ttlMs: STALE_SESSION_TTL_MS });
          return Response.json({
            ok: true,
            pid: process.pid,
            startedAt: new Date(startedAt).toISOString(),
            uptimeMs: Date.now() - startedAt,
            sessionApi: `${config.httpOrigin}${HUNK_SESSION_API_PATH}`,
            sessionCapabilities: `${config.httpOrigin}${HUNK_SESSION_CAPABILITIES_PATH}`,
            sessionSocket: `${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`,
            sessions: state.listSessions().length,
            pendingCommands: state.getPendingCommandCount(),
            staleSessionTtlMs: STALE_SESSION_TTL_MS,
          });
        }

        if (url.pathname === HUNK_SESSION_CAPABILITIES_PATH) {
          return Response.json(sessionCapabilities());
        }

        if (url.pathname === HUNK_SESSION_API_PATH) {
          return handleSessionApiRequest(state, request);
        }

        if (url.pathname === "/mcp") {
          return jsonError(
            "Hunk no longer exposes agent-facing MCP tools. Use `hunk session ...` instead.",
            410,
          );
        }

        if (url.pathname === HUNK_SESSION_SOCKET_PATH) {
          if (bunServer.upgrade(request, { data: {} })) {
            return undefined;
          }

          return new Response("Expected websocket upgrade.", { status: 426 });
        }

        return new Response("Not found.", { status: 404 });
      },
      websocket: {
        message: (socket, message) => {
          if (typeof message !== "string") {
            return;
          }

          let parsed: SessionClientMessage;
          try {
            parsed = JSON.parse(message) as SessionClientMessage;
          } catch {
            return;
          }

          switch (parsed.type) {
            case "register":
              state.registerSession(socket, parsed.registration, parsed.snapshot);
              break;
            case "snapshot":
              state.updateSnapshot(parsed.sessionId, parsed.snapshot);
              break;
            case "heartbeat":
              state.markSessionSeen(parsed.sessionId);
              break;
            case "command-result":
              state.handleCommandResult(parsed);
              break;
          }
        },
        close: (socket) => {
          state.unregisterSocket(socket);
        },
      },
    });
  } catch (error) {
    clearInterval(sweepTimer);
    throw formatDaemonServeError(error, config.host, config.port);
  }

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearInterval(sweepTimer);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);

    state.shutdown();
    server.stop(true);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`Hunk session daemon listening on ${config.httpOrigin}${HUNK_SESSION_API_PATH}`);
  console.log(`Hunk session websocket listening on ${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`);

  return server;
}
