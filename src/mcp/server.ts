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

const DEFAULT_STALE_SESSION_TTL_MS = 45_000;
const DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const SUPPORTED_SESSION_ACTIONS: SessionDaemonAction[] = [
  "list",
  "get",
  "context",
  "navigate",
  "reload",
  "comment-add",
  "comment-list",
  "comment-rm",
  "comment-clear",
];

export interface ServeHunkMcpServerOptions {
  idleTimeoutMs?: number;
  staleSessionTtlMs?: number;
  staleSessionSweepIntervalMs?: number;
}

export type RunningHunkMcpServer = ReturnType<typeof Bun.serve<{}>> & {
  stopped: Promise<void>;
};

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
      case "reload":
        response = {
          result: await state.sendReloadSession({
            ...input.selector,
            nextInput: input.nextInput,
            sourcePath: input.sourcePath,
          }),
        };
        break;
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
export function serveHunkMcpServer(options: ServeHunkMcpServerOptions = {}): RunningHunkMcpServer {
  const config = resolveHunkMcpConfig();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const staleSessionTtlMs = options.staleSessionTtlMs ?? DEFAULT_STALE_SESSION_TTL_MS;
  const staleSessionSweepIntervalMs =
    options.staleSessionSweepIntervalMs ?? DEFAULT_STALE_SESSION_SWEEP_INTERVAL_MS;
  const state = new HunkDaemonState();
  const startedAt = Date.now();
  let resolveStopped: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let lastActivityAt = startedAt;
  let shuttingDown = false;
  let sweepTimer: Timer | null = null;
  let idleTimer: Timer | null = null;
  let server: ReturnType<typeof Bun.serve<{}>> | null = null;

  const hasActiveWork = () => state.getSessionCount() > 0 || state.getPendingCommandCount() > 0;

  const clearIdleShutdownTimer = () => {
    if (!idleTimer) {
      return;
    }

    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    clearIdleShutdownTimer();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);

    state.shutdown();
    server?.stop(true);
    resolveStopped?.();
    resolveStopped = null;
  };

  const refreshIdleShutdownTimer = () => {
    clearIdleShutdownTimer();

    if (shuttingDown || idleTimeoutMs <= 0 || hasActiveWork()) {
      return;
    }

    const idleForMs = Date.now() - lastActivityAt;
    const remainingMs = Math.max(0, idleTimeoutMs - idleForMs);

    idleTimer = setTimeout(() => {
      idleTimer = null;

      if (shuttingDown || hasActiveWork()) {
        return;
      }

      if (Date.now() - lastActivityAt < idleTimeoutMs) {
        refreshIdleShutdownTimer();
        return;
      }

      shutdown();
    }, remainingMs);
    idleTimer.unref?.();
  };

  const noteActivity = () => {
    lastActivityAt = Date.now();
    refreshIdleShutdownTimer();
  };

  sweepTimer = setInterval(() => {
    const removed = state.pruneStaleSessions({ ttlMs: staleSessionTtlMs });
    if (removed > 0) {
      noteActivity();
    }
  }, staleSessionSweepIntervalMs);
  sweepTimer.unref?.();

  try {
    server = Bun.serve<{}>({
      hostname: config.host,
      port: config.port,
      fetch: async (request, bunServer) => {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          const removed = state.pruneStaleSessions({ ttlMs: staleSessionTtlMs });
          if (removed > 0) {
            noteActivity();
          }

          return Response.json({
            ok: true,
            pid: process.pid,
            startedAt: new Date(startedAt).toISOString(),
            uptimeMs: Date.now() - startedAt,
            sessionApi: `${config.httpOrigin}${HUNK_SESSION_API_PATH}`,
            sessionCapabilities: `${config.httpOrigin}${HUNK_SESSION_CAPABILITIES_PATH}`,
            sessionSocket: `${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`,
            sessions: state.getSessionCount(),
            pendingCommands: state.getPendingCommandCount(),
            staleSessionTtlMs,
          });
        }

        if (url.pathname === HUNK_SESSION_CAPABILITIES_PATH) {
          noteActivity();
          return Response.json(sessionCapabilities());
        }

        if (url.pathname === HUNK_SESSION_API_PATH) {
          noteActivity();
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
              noteActivity();
              break;
            case "snapshot":
              state.updateSnapshot(parsed.sessionId, parsed.snapshot);
              noteActivity();
              break;
            case "heartbeat":
              state.markSessionSeen(parsed.sessionId);
              noteActivity();
              break;
            case "command-result":
              state.handleCommandResult(parsed);
              noteActivity();
              break;
          }
        },
        close: (socket) => {
          state.unregisterSocket(socket);
          noteActivity();
        },
      },
    });
  } catch (error) {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    clearIdleShutdownTimer();
    throw formatDaemonServeError(error, config.host, config.port);
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  refreshIdleShutdownTimer();

  console.log(`Hunk session daemon listening on ${config.httpOrigin}${HUNK_SESSION_API_PATH}`);
  console.log(`Hunk session websocket listening on ${config.wsOrigin}${HUNK_SESSION_SOCKET_PATH}`);

  return Object.assign(server, { stopped }) as RunningHunkMcpServer;
}
