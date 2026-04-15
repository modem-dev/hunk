import { resolveSessionBrokerConfig } from "../session-broker/brokerConfig";
import type { SessionTerminalLocation, SessionTerminalMetadata } from "@hunk/session-broker-core";
import { readHunkSessionDaemonCapabilities } from "../session/capabilities";
import {
  HUNK_SESSION_API_PATH,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
} from "../session/protocol";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
} from "./types";
import type {
  SessionCommentAddCommandInput,
  SessionCommentApplyCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionNavigateCommandInput,
  SessionReloadCommandInput,
  SessionReviewCommandInput,
  SessionSelectorInput,
} from "../core/types";
import { describeSessionSelector } from "@hunk/session-broker-core";

export interface HunkSessionCliClient {
  getCapabilities(): Promise<SessionDaemonCapabilities | null>;
  listSessions(): Promise<ListedSession[]>;
  getSession(selector: SessionSelectorInput): Promise<ListedSession>;
  getSelectedContext(selector: SessionSelectorInput): Promise<SelectedSessionContext>;
  getSessionReview(input: SessionReviewCommandInput): Promise<SessionReview>;
  navigateToHunk(input: SessionNavigateCommandInput): Promise<NavigatedSelectionResult>;
  reloadSession(input: SessionReloadCommandInput): Promise<ReloadedSessionResult>;
  addComment(input: SessionCommentAddCommandInput): Promise<AppliedCommentResult>;
  applyComments(input: SessionCommentApplyCommandInput): Promise<AppliedCommentBatchResult>;
  listComments(input: SessionCommentListCommandInput): Promise<SessionLiveCommentSummary[]>;
  removeComment(input: SessionCommentRemoveCommandInput): Promise<RemovedCommentResult>;
  clearComments(input: SessionCommentClearCommandInput): Promise<ClearedCommentsResult>;
}

async function extractResponseError(response: Response) {
  try {
    const parsed = (await response.json()) as { error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || "Unknown Hunk session daemon error.";
}

class HttpHunkSessionCliClient implements HunkSessionCliClient {
  private readonly config = resolveSessionBrokerConfig();

  private async request<ResultType>(input: SessionDaemonRequest) {
    const response = await fetch(`${this.config.httpOrigin}${HUNK_SESSION_API_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(await extractResponseError(response));
    }

    return (await response.json()) as ResultType;
  }

  async getCapabilities() {
    return readHunkSessionDaemonCapabilities(this.config);
  }

  async listSessions() {
    return (await this.request<{ sessions: ListedSession[] }>({ action: "list" })).sessions;
  }

  async getSession(selector: SessionSelectorInput) {
    return (await this.request<{ session: ListedSession }>({ action: "get", selector })).session;
  }

  async getSelectedContext(selector: SessionSelectorInput) {
    return (
      await this.request<{ context: SelectedSessionContext }>({ action: "context", selector })
    ).context;
  }

  async getSessionReview(input: SessionReviewCommandInput) {
    return (
      await this.request<{ review: SessionReview }>({
        action: "review",
        selector: input.selector,
        includePatch: input.includePatch,
      })
    ).review;
  }

  async navigateToHunk(input: SessionNavigateCommandInput) {
    return (
      await this.request<{ result: NavigatedSelectionResult }>({
        action: "navigate",
        selector: input.selector,
        filePath: input.filePath,
        hunkNumber: input.hunkNumber,
        side: input.side,
        line: input.line,
        commentDirection: input.commentDirection,
      })
    ).result;
  }

  async reloadSession(input: SessionReloadCommandInput) {
    return (
      await this.request<{ result: ReloadedSessionResult }>({
        action: "reload",
        selector: input.selector,
        nextInput: input.nextInput,
        sourcePath: input.sourcePath,
      })
    ).result;
  }

  async addComment(input: SessionCommentAddCommandInput) {
    return (
      await this.request<{ result: AppliedCommentResult }>({
        action: "comment-add",
        selector: input.selector,
        filePath: input.filePath,
        side: input.side,
        line: input.line,
        summary: input.summary,
        rationale: input.rationale,
        author: input.author,
        reveal: input.reveal,
      })
    ).result;
  }

  async applyComments(input: SessionCommentApplyCommandInput) {
    return (
      await this.request<{ result: AppliedCommentBatchResult }>({
        action: "comment-apply",
        selector: input.selector,
        comments: input.comments,
        revealMode: input.revealMode,
      })
    ).result;
  }

  async listComments(input: SessionCommentListCommandInput) {
    return (
      await this.request<{ comments: SessionLiveCommentSummary[] }>({
        action: "comment-list",
        selector: input.selector,
        filePath: input.filePath,
      })
    ).comments;
  }

  async removeComment(input: SessionCommentRemoveCommandInput) {
    return (
      await this.request<{ result: RemovedCommentResult }>({
        action: "comment-rm",
        selector: input.selector,
        commentId: input.commentId,
      })
    ).result;
  }

  async clearComments(input: SessionCommentClearCommandInput) {
    return (
      await this.request<{ result: ClearedCommentsResult }>({
        action: "comment-clear",
        selector: input.selector,
        filePath: input.filePath,
      })
    ).result;
  }
}

/** Create the concrete Hunk session CLI client that speaks to the broker-backed HTTP API. */
export function createHttpHunkSessionCliClient(): HunkSessionCliClient {
  return new HttpHunkSessionCliClient();
}

export function stringifyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatSelectedSummary(session: ListedSession) {
  const filePath = session.snapshot.state.selectedFilePath ?? "(none)";
  const hunkNumber = session.snapshot.state.selectedFilePath
    ? session.snapshot.state.selectedHunkIndex + 1
    : 0;
  return filePath === "(none)" ? filePath : `${filePath} hunk ${hunkNumber}`;
}

function formatTerminalLocation(location: SessionTerminalLocation) {
  const parts: string[] = [];

  if (location.tty) {
    parts.push(location.tty);
  }

  if (location.windowId) {
    parts.push(`window ${location.windowId}`);
  }

  if (location.tabId) {
    parts.push(`tab ${location.tabId}`);
  }

  if (location.paneId) {
    parts.push(`pane ${location.paneId}`);
  }

  if (location.terminalId) {
    parts.push(`terminal ${location.terminalId}`);
  }

  if (location.sessionId) {
    parts.push(`session ${location.sessionId}`);
  }

  return parts.length > 0 ? parts.join(", ") : "present";
}

function formatTerminalLines(
  terminal: SessionTerminalMetadata | undefined,
  {
    headerLabel,
    locationLabel,
  }: {
    headerLabel: string;
    locationLabel: string;
  },
) {
  if (!terminal) {
    return [];
  }

  return [
    ...(terminal.program ? [`${headerLabel}: ${terminal.program}`] : []),
    ...terminal.locations.map(
      (location) => `${locationLabel}[${location.source}]: ${formatTerminalLocation(location)}`,
    ),
  ];
}

export function formatListOutput(sessions: ListedSession[]) {
  if (sessions.length === 0) {
    return "No active Hunk sessions.\n";
  }

  return `${sessions
    .map((session) => {
      const terminal = session.terminal;
      return [
        `${session.sessionId}  ${session.title}`,
        `  path: ${session.cwd}`,
        `  repo: ${session.repoRoot ?? "-"}`,
        ...formatTerminalLines(terminal, {
          headerLabel: "  terminal",
          locationLabel: "  location",
        }),
        `  focus: ${formatSelectedSummary(session)}`,
        `  files: ${session.fileCount}`,
        `  comments: ${session.snapshot.state.liveCommentCount}`,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

export function formatSessionOutput(session: ListedSession) {
  const terminal = session.terminal;

  return [
    `Session: ${session.sessionId}`,
    `Title: ${session.title}`,
    `Source: ${session.sourceLabel}`,
    `Path: ${session.cwd}`,
    `Repo: ${session.repoRoot ?? "-"}`,
    `Input: ${session.inputKind}`,
    `Launched: ${session.launchedAt}`,
    ...formatTerminalLines(terminal, {
      headerLabel: "Terminal",
      locationLabel: "Location",
    }),
    `Selected: ${formatSelectedSummary(session)}`,
    `Agent notes visible: ${session.snapshot.state.showAgentNotes ? "yes" : "no"}`,
    `Live comments: ${session.snapshot.state.liveCommentCount}`,
    "Files:",
    ...session.files.map(
      (file) =>
        `  - ${file.path} (+${file.additions} -${file.deletions}, hunks: ${file.hunkCount})`,
    ),
    "",
  ].join("\n");
}

export function formatContextOutput(context: SelectedSessionContext) {
  const selectedFile = context.selectedFile?.path ?? "(none)";
  const hunkNumber = context.selectedHunk ? context.selectedHunk.index + 1 : 0;
  const oldRange = context.selectedHunk?.oldRange
    ? `${context.selectedHunk.oldRange[0]}..${context.selectedHunk.oldRange[1]}`
    : "-";
  const newRange = context.selectedHunk?.newRange
    ? `${context.selectedHunk.newRange[0]}..${context.selectedHunk.newRange[1]}`
    : "-";

  return [
    `Session: ${context.sessionId}`,
    `Title: ${context.title}`,
    `Path: ${context.cwd ?? "-"}`,
    `Repo: ${context.repoRoot ?? "-"}`,
    `File: ${selectedFile}`,
    `Hunk: ${context.selectedHunk ? hunkNumber : "-"}`,
    `Old range: ${oldRange}`,
    `New range: ${newRange}`,
    `Agent notes visible: ${context.showAgentNotes ? "yes" : "no"}`,
    `Live comments: ${context.liveCommentCount}`,
    "",
  ].join("\n");
}

/** Render one human-readable summary of the exported live session review model. */
export function formatReviewOutput(review: SessionReview) {
  const selectedFile = review.selectedFile?.path ?? "(none)";
  const hunkNumber = review.selectedHunk ? review.selectedHunk.index + 1 : "-";

  return [
    `Session: ${review.sessionId}`,
    `Title: ${review.title}`,
    `Source: ${review.sourceLabel}`,
    `Path: ${review.cwd ?? "-"}`,
    `Repo: ${review.repoRoot ?? "-"}`,
    `Input: ${review.inputKind}`,
    `Selected file: ${selectedFile}`,
    `Selected hunk: ${hunkNumber}`,
    `Agent notes visible: ${review.showAgentNotes ? "yes" : "no"}`,
    `Live comments: ${review.liveCommentCount}`,
    "Files:",
    ...review.files.flatMap((file) => [
      `  - ${file.path} (+${file.additions} -${file.deletions}, hunks: ${file.hunkCount})`,
      ...file.hunks.map((hunk) => `      hunk ${hunk.index + 1}: ${hunk.header}`),
    ]),
    "",
  ].join("\n");
}

export function formatNavigationOutput(
  selector: SessionSelectorInput,
  result: NavigatedSelectionResult,
) {
  return `Focused ${result.filePath} hunk ${result.hunkIndex + 1} in ${describeSessionSelector(selector)}.\n`;
}

export function formatReloadOutput(selector: SessionSelectorInput, result: ReloadedSessionResult) {
  const selected = result.selectedFilePath
    ? `${result.selectedFilePath} hunk ${result.selectedHunkIndex + 1}`
    : "(no files)";
  return `Reloaded ${describeSessionSelector(selector)} with ${result.title} (${result.fileCount} files). Selected: ${selected}.\n`;
}

export function formatCommentOutput(selector: SessionSelectorInput, result: AppliedCommentResult) {
  return `Added live comment ${result.commentId} on ${result.filePath}:${result.line} (${result.side}) in hunk ${result.hunkIndex + 1} for ${describeSessionSelector(selector)}.\n`;
}

export function formatCommentApplyOutput(
  selector: SessionSelectorInput,
  result: AppliedCommentBatchResult,
) {
  if (result.applied.length === 0) {
    return `Applied 0 live comments to ${describeSessionSelector(selector)}.\n`;
  }

  return `${[
    `Applied ${result.applied.length} live comments to ${describeSessionSelector(selector)}:`,
    ...result.applied.map(
      (comment) =>
        `  - ${comment.commentId} on ${comment.filePath}:${comment.line} (${comment.side}) hunk ${comment.hunkIndex + 1}`,
    ),
    "",
  ].join("\n")}`;
}

export function formatCommentListOutput(
  selector: SessionSelectorInput,
  comments: SessionLiveCommentSummary[],
) {
  if (comments.length === 0) {
    return `No live comments for ${describeSessionSelector(selector)}.\n`;
  }

  return `${comments
    .map((comment) =>
      [
        `${comment.commentId}  ${comment.filePath}:${comment.line} (${comment.side})`,
        `  hunk: ${comment.hunkIndex + 1}`,
        `  summary: ${comment.summary}`,
        ...(comment.author ? [`  author: ${comment.author}`] : []),
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

export function formatRemoveCommentOutput(
  selector: SessionSelectorInput,
  result: RemovedCommentResult,
) {
  return `Removed live comment ${result.commentId} from ${describeSessionSelector(selector)}. Remaining comments: ${result.remainingCommentCount}.\n`;
}

export function formatClearCommentsOutput(
  selector: SessionSelectorInput,
  result: ClearedCommentsResult,
) {
  const scope = result.filePath
    ? `${result.filePath} in ${describeSessionSelector(selector)}`
    : describeSessionSelector(selector);
  return `Cleared ${result.removedCount} live comments from ${scope}. Remaining comments: ${result.remainingCommentCount}.\n`;
}
