import { randomUUID } from "node:crypto";
import { parseSessionRegistration, parseSessionSnapshot } from "./sessionWire";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  ClearCommentsToolInput,
  CommentBatchToolInput,
  CommentToolInput,
  HunkSessionRegistration,
  HunkSessionSnapshot,
  ListedSession,
  NavigateToHunkToolInput,
  NavigatedSelectionResult,
  ReloadSessionToolInput,
  ReloadedSessionResult,
  RemoveCommentToolInput,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionCommandResult,
  SessionFileSummary,
  SessionReview,
  SessionReviewFile,
  SessionServerMessage,
  SessionTargetInput,
} from "./types";

interface PendingCommand {
  sessionId: string;
  resolve: (result: SessionCommandResult) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

interface DaemonSessionSocket {
  send(data: string): unknown;
}

interface SessionEntry {
  registration: HunkSessionRegistration;
  snapshot: HunkSessionSnapshot;
  socket: DaemonSessionSocket;
  connectedAt: string;
  lastSeenAt: string;
}

export type UpdateSnapshotResult = "updated" | "invalid" | "not-found";

export interface SessionTargetSelector {
  sessionId?: string;
  sessionPath?: string;
  repoRoot?: string;
}

function describeSessionChoices(sessions: ListedSession[]) {
  return sessions.map((session) => `${session.sessionId} (${session.title})`).join(", ");
}

function findSelectedFile(session: ListedSession) {
  return (
    session.files.find(
      (file) =>
        file.id === session.snapshot.selectedFileId ||
        file.path === session.snapshot.selectedFilePath ||
        file.previousPath === session.snapshot.selectedFilePath,
    ) ?? null
  );
}

/** Match one review-export file against the live snapshot's current file selection. */
function findSelectedReviewFile(files: SessionReviewFile[], snapshot: HunkSessionSnapshot) {
  return (
    files.find(
      (file) =>
        file.id === snapshot.selectedFileId ||
        file.path === snapshot.selectedFilePath ||
        file.previousPath === snapshot.selectedFilePath,
    ) ?? null
  );
}

/** Reduce one review-export file back to the summary fields used by session listings. */
function summarizeReviewFile(reviewFile: SessionReviewFile): SessionFileSummary {
  return {
    id: reviewFile.id,
    path: reviewFile.path,
    previousPath: reviewFile.previousPath,
    additions: reviewFile.additions,
    deletions: reviewFile.deletions,
    hunkCount: reviewFile.hunkCount,
  };
}

/** Serialize one review-export file while keeping raw patch text opt-in for callers. */
function serializeReviewFile(
  reviewFile: SessionReviewFile,
  includePatch: boolean,
): SessionReviewFile {
  return includePatch
    ? reviewFile
    : {
        ...summarizeReviewFile(reviewFile),
        hunks: reviewFile.hunks,
      };
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

  const sessionPath = selector.sessionPath;
  if (sessionPath) {
    const matches = sessions.filter((session) => session.cwd === sessionPath);
    if (matches.length === 0) {
      throw new Error(`No active Hunk session matches session path ${sessionPath}.`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple active Hunk sessions match session path ${sessionPath}; specify sessionId instead. ` +
          `Matches: ${describeSessionChoices(matches)}.`,
      );
    }

    return matches[0]!;
  }

  if (selector.repoRoot) {
    const matches = sessions.filter((session) => session.repoRoot === selector.repoRoot);
    if (matches.length === 0) {
      throw new Error(`No active Hunk session matches repoRoot ${selector.repoRoot}.`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple active Hunk sessions match repoRoot ${selector.repoRoot}; specify sessionId instead. ` +
          `Matches: ${describeSessionChoices(matches)}.`,
      );
    }

    return matches[0]!;
  }

  if (sessions.length === 1) {
    return sessions[0]!;
  }

  if (sessions.length === 0) {
    throw new Error(
      "No active Hunk sessions are registered with the daemon. Open Hunk and wait for it to connect.",
    );
  }

  throw new Error(
    `Multiple active Hunk sessions are registered; specify sessionId, sessionPath, or repoRoot. ` +
      `Sessions: ${describeSessionChoices(sessions)}.`,
  );
}

/** Track registered Hunk sessions and route session-daemon commands onto the correct live TUI instance. */
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
        terminal: entry.registration.terminal,
        fileCount: entry.registration.files.length,
        files: entry.registration.files.map(summarizeReviewFile),
        snapshot: entry.snapshot,
      }))
      .sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt));
  }

  getSession(selector: SessionTargetSelector) {
    return resolveSessionTarget(this.listSessions(), selector);
  }

  /** Return the live session's loaded review model, with raw patch text included only on demand. */
  getSessionReview(
    selector: SessionTargetSelector,
    options: { includePatch?: boolean } = {},
  ): SessionReview {
    const entry = this.getSessionEntry(selector);
    const { registration, snapshot } = entry;
    const selectedFile = findSelectedReviewFile(registration.files, snapshot);
    const includePatch = options.includePatch ?? false;

    return {
      sessionId: registration.sessionId,
      title: registration.title,
      sourceLabel: registration.sourceLabel,
      cwd: registration.cwd,
      repoRoot: registration.repoRoot,
      inputKind: registration.inputKind,
      selectedFile: selectedFile ? serializeReviewFile(selectedFile, includePatch) : null,
      selectedHunk: selectedFile ? (selectedFile.hunks[snapshot.selectedHunkIndex] ?? null) : null,
      showAgentNotes: snapshot.showAgentNotes,
      liveCommentCount: snapshot.liveCommentCount,
      files: registration.files.map((file) => serializeReviewFile(file, includePatch)),
    };
  }

  getSelectedContext(selector: SessionTargetSelector): SelectedSessionContext {
    const session = this.getSession(selector);
    const selectedFile = findSelectedFile(session);

    return {
      sessionId: session.sessionId,
      title: session.title,
      sourceLabel: session.sourceLabel,
      cwd: session.cwd,
      repoRoot: session.repoRoot,
      inputKind: session.inputKind,
      selectedFile,
      selectedHunk: selectedFile
        ? {
            index: session.snapshot.selectedHunkIndex,
            oldRange: session.snapshot.selectedHunkOldRange,
            newRange: session.snapshot.selectedHunkNewRange,
          }
        : null,
      showAgentNotes: session.snapshot.showAgentNotes,
      liveCommentCount: session.snapshot.liveCommentCount,
    };
  }

  listComments(selector: SessionTargetSelector, filter: { filePath?: string } = {}) {
    const session = this.getSession(selector);
    const comments = session.snapshot.liveComments;

    if (!filter.filePath) {
      return comments;
    }

    return comments.filter((comment) => comment.filePath === filter.filePath);
  }

  getSessionCount() {
    return this.sessions.size;
  }

  getPendingCommandCount() {
    return this.pendingCommands.size;
  }

  registerSession(socket: DaemonSessionSocket, registrationInput: unknown, snapshotInput: unknown) {
    const registration = parseSessionRegistration(registrationInput);
    const snapshot = parseSessionSnapshot(snapshotInput);
    if (!registration || !snapshot) {
      const previousSessionId = this.sessionIdsBySocket.get(socket);
      if (previousSessionId) {
        // Drop any stale session already tied to this socket so an incompatible replacement
        // payload cannot leave old review data behind after an upgrade or reload.
        this.removeSession(
          previousSessionId,
          new Error("The Hunk session sent an incompatible registration payload."),
        );
      }

      return false;
    }

    const previousSessionId = this.sessionIdsBySocket.get(socket);
    if (previousSessionId && previousSessionId !== registration.sessionId) {
      this.unregisterSocket(socket);
    }

    const existing = this.sessions.get(registration.sessionId);
    if (existing && existing.socket !== socket) {
      this.sessionIdsBySocket.delete(existing.socket);
      this.rejectPendingCommandsForSession(
        registration.sessionId,
        new Error("Hunk session reconnected before the command completed."),
      );
    }

    const now = new Date().toISOString();
    this.sessions.set(registration.sessionId, {
      registration,
      snapshot,
      socket,
      connectedAt: now,
      lastSeenAt: now,
    });
    this.sessionIdsBySocket.set(socket, registration.sessionId);
    return true;
  }

  updateSnapshot(sessionId: string, snapshotInput: unknown): UpdateSnapshotResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return "not-found";
    }

    const snapshot = parseSessionSnapshot(snapshotInput);
    if (!snapshot) {
      return "invalid";
    }

    this.sessions.set(sessionId, {
      ...entry,
      snapshot,
      lastSeenAt: new Date().toISOString(),
    });
    return "updated";
  }

  markSessionSeen(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.sessions.set(sessionId, {
      ...entry,
      lastSeenAt: new Date().toISOString(),
    });
  }

  unregisterSocket(socket: DaemonSessionSocket) {
    const sessionId = this.sessionIdsBySocket.get(socket);
    if (!sessionId) {
      return;
    }

    this.removeSession(sessionId, new Error("The targeted Hunk session disconnected."));
  }

  pruneStaleSessions({ ttlMs, now = Date.now() }: { ttlMs: number; now?: number }) {
    let removed = 0;
    const cutoff = now - ttlMs;

    for (const [sessionId, entry] of this.sessions.entries()) {
      const lastSeenAt = Date.parse(entry.lastSeenAt);
      if (!Number.isFinite(lastSeenAt) || lastSeenAt > cutoff) {
        continue;
      }

      this.removeSession(
        sessionId,
        new Error(
          "The targeted Hunk session became stale and was removed from the session daemon.",
        ),
      );
      removed += 1;
    }

    return removed;
  }

  sendComment(input: CommentToolInput) {
    return this.sendCommand<AppliedCommentResult, "comment">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "comment",
      input,
      "Timed out waiting for the Hunk session to apply the comment.",
    );
  }

  sendCommentBatch(input: CommentBatchToolInput) {
    return this.sendCommand<AppliedCommentBatchResult, "comment_batch">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "comment_batch",
      input,
      "Timed out waiting for the Hunk session to apply the comment batch.",
      30_000,
    );
  }

  sendNavigateToHunk(input: NavigateToHunkToolInput) {
    return this.sendCommand<NavigatedSelectionResult, "navigate_to_hunk">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "navigate_to_hunk",
      input,
      "Timed out waiting for the Hunk session to navigate to the requested hunk.",
    );
  }

  sendReloadSession(input: ReloadSessionToolInput) {
    return this.sendCommand<ReloadedSessionResult, "reload_session">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "reload_session",
      input,
      "Timed out waiting for the Hunk session to reload the requested contents.",
      30_000,
    );
  }

  sendRemoveComment(input: RemoveCommentToolInput) {
    return this.sendCommand<RemovedCommentResult, "remove_comment">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "remove_comment",
      input,
      "Timed out waiting for the Hunk session to remove the requested comment.",
    );
  }

  sendClearComments(input: ClearCommentsToolInput) {
    return this.sendCommand<ClearedCommentsResult, "clear_comments">(
      { sessionId: input.sessionId, sessionPath: input.sessionPath, repoRoot: input.repoRoot },
      "clear_comments",
      input,
      "Timed out waiting for the Hunk session to clear the requested comments.",
    );
  }

  handleCommandResult(message: {
    requestId: string;
    ok: boolean;
    result?: SessionCommandResult;
    error?: string;
  }) {
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

  shutdown(error = new Error("The Hunk session daemon shut down.")) {
    for (const [requestId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(requestId);
      pending.reject(error);
    }

    this.sessionIdsBySocket.clear();
    this.sessions.clear();
  }

  /** Resolve one live session selector into the full in-memory registration entry. */
  private getSessionEntry(selector: SessionTargetSelector) {
    const session = resolveSessionTarget(this.listSessions(), selector);
    const entry = this.sessions.get(session.sessionId);
    if (!entry) {
      throw new Error("The targeted Hunk session is no longer connected.");
    }

    return entry;
  }

  private sendCommand<
    ResultType extends SessionCommandResult,
    CommandName extends SessionServerMessage["command"],
  >(
    selector: SessionTargetInput,
    command: CommandName,
    input: Extract<SessionServerMessage, { command: CommandName }>["input"],
    timeoutMessage: string,
    timeoutMs = 15_000,
  ) {
    const session = resolveSessionTarget(this.listSessions(), selector);
    const requestId = randomUUID();

    return new Promise<ResultType>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      this.pendingCommands.set(requestId, {
        sessionId: session.sessionId,
        resolve: (result) => resolve(result as ResultType),
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

      try {
        const message = {
          type: "command",
          requestId,
          command,
          input,
        } as Extract<SessionServerMessage, { command: CommandName }>;

        entry.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCommands.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("The targeted Hunk session could not receive the command."),
        );
      }
    });
  }

  private removeSession(sessionId: string, error: Error) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.sessions.delete(sessionId);
    if (this.sessionIdsBySocket.get(entry.socket) === sessionId) {
      this.sessionIdsBySocket.delete(entry.socket);
    }

    this.rejectPendingCommandsForSession(sessionId, error);
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
