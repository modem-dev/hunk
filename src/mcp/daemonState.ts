import { randomUUID } from "node:crypto";
import type { AppliedCommentResult, CommentToolInput, HunkSessionRegistration, HunkSessionSnapshot, ListedSession } from "./types";

interface PendingCommand {
  sessionId: string;
  resolve: (result: AppliedCommentResult) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

export interface DaemonSessionSocket {
  send(data: string): unknown;
}

interface SessionEntry {
  registration: HunkSessionRegistration;
  snapshot: HunkSessionSnapshot;
  socket: DaemonSessionSocket;
  connectedAt: string;
}

export interface SessionTargetSelector {
  sessionId?: string;
  repoRoot?: string;
}

/** Resolve which live Hunk session one external command should target. */
export function resolveSessionTarget(sessions: ListedSession[], selector: SessionTargetSelector) {
  if (selector.sessionId) {
    const matched = sessions.find((session) => session.sessionId === selector.sessionId);
    if (!matched) {
      throw new Error(`No active Hunk session matches sessionId ${selector.sessionId}.`);
    }

    return matched;
  }

  if (selector.repoRoot) {
    const matches = sessions.filter((session) => session.repoRoot === selector.repoRoot);
    if (matches.length === 0) {
      throw new Error(`No active Hunk session matches repoRoot ${selector.repoRoot}.`);
    }

    if (matches.length > 1) {
      throw new Error(`Multiple active Hunk sessions match repoRoot ${selector.repoRoot}; specify sessionId instead.`);
    }

    return matches[0]!;
  }

  if (sessions.length === 1) {
    return sessions[0]!;
  }

  if (sessions.length === 0) {
    throw new Error("No active Hunk sessions are registered with the daemon.");
  }

  throw new Error("Multiple active Hunk sessions are registered; specify sessionId or repoRoot.");
}

/** Track registered Hunk sessions and route MCP commands onto the correct live TUI instance. */
export class HunkDaemonState {
  private sessions = new Map<string, SessionEntry>();
  private sessionIdsBySocket = new Map<DaemonSessionSocket, string>();
  private pendingCommands = new Map<string, PendingCommand>();

  listSessions(): ListedSession[] {
    return [...this.sessions.values()]
      .map((entry) => ({
        sessionId: entry.registration.sessionId,
        pid: entry.registration.pid,
        cwd: entry.registration.cwd,
        repoRoot: entry.registration.repoRoot,
        inputKind: entry.registration.inputKind,
        title: entry.registration.title,
        sourceLabel: entry.registration.sourceLabel,
        launchedAt: entry.registration.launchedAt,
        fileCount: entry.registration.files.length,
        files: entry.registration.files,
        snapshot: entry.snapshot,
      }))
      .sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt));
  }

  getSession(selector: SessionTargetSelector) {
    return resolveSessionTarget(this.listSessions(), selector);
  }

  registerSession(socket: DaemonSessionSocket, registration: HunkSessionRegistration, snapshot: HunkSessionSnapshot) {
    const previousSessionId = this.sessionIdsBySocket.get(socket);
    if (previousSessionId && previousSessionId !== registration.sessionId) {
      this.unregisterSocket(socket);
    }

    const existing = this.sessions.get(registration.sessionId);
    if (existing && existing.socket !== socket) {
      this.sessionIdsBySocket.delete(existing.socket);
      this.rejectPendingCommandsForSession(registration.sessionId, new Error("Hunk session reconnected before the command completed."));
    }

    this.sessions.set(registration.sessionId, {
      registration,
      snapshot,
      socket,
      connectedAt: new Date().toISOString(),
    });
    this.sessionIdsBySocket.set(socket, registration.sessionId);
  }

  updateSnapshot(sessionId: string, snapshot: HunkSessionSnapshot) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.sessions.set(sessionId, {
      ...entry,
      snapshot,
    });
  }

  unregisterSocket(socket: DaemonSessionSocket) {
    const sessionId = this.sessionIdsBySocket.get(socket);
    if (!sessionId) {
      return;
    }

    this.sessionIdsBySocket.delete(socket);
    this.sessions.delete(sessionId);
    this.rejectPendingCommandsForSession(sessionId, new Error("The targeted Hunk session disconnected."));
  }

  async sendComment(input: CommentToolInput) {
    const session = resolveSessionTarget(this.listSessions(), {
      sessionId: input.sessionId,
      repoRoot: input.repoRoot,
    });
    const requestId = randomUUID();

    return new Promise<AppliedCommentResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error("Timed out waiting for the Hunk session to apply the comment."));
      }, 15_000);

      this.pendingCommands.set(requestId, {
        sessionId: session.sessionId,
        resolve,
        reject,
        timeout,
      });

      const entry = this.sessions.get(session.sessionId);
      if (!entry) {
        clearTimeout(timeout);
        this.pendingCommands.delete(requestId);
        reject(new Error("The targeted Hunk session is no longer connected."));
        return;
      }

      entry.socket.send(
        JSON.stringify({
          type: "command",
          requestId,
          command: "comment",
          input,
        }),
      );
    });
  }

  handleCommandResult(message: { requestId: string; ok: boolean; result?: AppliedCommentResult; error?: string }) {
    const pending = this.pendingCommands.get(message.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(message.requestId);

    if (message.ok && message.result) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error ?? "The Hunk session failed to handle the command."));
  }

  private rejectPendingCommandsForSession(sessionId: string, error: Error) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      if (pending.sessionId !== sessionId) {
        continue;
      }

      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }
  }
}
