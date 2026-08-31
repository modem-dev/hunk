import { sanitizeTerminalText } from "../../lib/terminalText";
import { resolveSessionBrokerConfig } from "../broker/brokerConfig";
import {
  SessionBrokerCallerClient,
  type SessionBrokerSignedRequestInit,
} from "@hunk/session-broker";
import type { SessionTerminalLocation, SessionTerminalMetadata } from "@hunk/session-broker-core";
import {
  HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
  withSessionDaemonHttpTimeout,
} from "../client/daemonHttp";
import { loadOrCreateHunkSessionBrokerCredentials } from "../broker/credentials";
import {
  HUNK_SESSION_BROKER_APP_ID,
  HUNK_SESSION_BROKER_APP_REVISION,
} from "../broker/appContract";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_CAPABILITIES_PATH,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
  type SessionDaemonResponses,
} from "../protocol";
import { parseSessionDaemonCapabilities, parseSessionDaemonResponse } from "../protocolSchemas";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  AppliedHighlightResult,
  ClearedCommentsResult,
  ClearedHighlightsResult,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewNoteSummary,
} from "../types";
import type {
  SessionCommentAddCommandInput,
  SessionCommentApplyCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionHighlightAddCommandInput,
  SessionHighlightClearCommandInput,
  SessionNavigateCommandInput,
  SessionReloadCommandInput,
  SessionReviewCommandInput,
  SessionSelectorInput,
} from "../../core/run/commandInputs";
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
  listComments(
    input: SessionCommentListCommandInput,
  ): Promise<Array<SessionLiveCommentSummary | SessionReviewNoteSummary>>;
  removeComment(input: SessionCommentRemoveCommandInput): Promise<RemovedCommentResult>;
  clearComments(input: SessionCommentClearCommandInput): Promise<ClearedCommentsResult>;
  addHighlight(input: SessionHighlightAddCommandInput): Promise<AppliedHighlightResult>;
  clearHighlights(input: SessionHighlightClearCommandInput): Promise<ClearedHighlightsResult>;
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

interface HunkCallerTransport {
  request(
    path: string,
    init?: SessionBrokerSignedRequestInit,
    options?: { readonly targetSpecific?: boolean },
  ): Promise<Response>;
}

class HttpHunkSessionCliClient implements HunkSessionCliClient {
  private readonly config = resolveSessionBrokerConfig();
  private callerPromise: Promise<HunkCallerTransport> | null = null;

  constructor(
    private readonly timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
    private readonly injectedCaller?: HunkCallerTransport,
  ) {}

  private caller() {
    if (this.injectedCaller) return Promise.resolve(this.injectedCaller);
    this.callerPromise ??= loadOrCreateHunkSessionBrokerCredentials().then(
      (credentials) =>
        new SessionBrokerCallerClient({
          appId: HUNK_SESSION_BROKER_APP_ID,
          appRevision: HUNK_SESSION_BROKER_APP_REVISION,
          origin: this.config.httpOrigin,
          credential: credentials.caller,
          daemon: {
            keyId: credentials.daemonIdentity.keyId,
            publicKey: credentials.daemonPublicKey,
          },
        }),
    );
    return this.callerPromise;
  }

  private async request<Action extends SessionDaemonAction>(
    input: Extract<SessionDaemonRequest, { action: Action }>,
  ): Promise<SessionDaemonResponses[Action]> {
    return withSessionDaemonHttpTimeout({
      operation: `complete session ${input.action}`,
      timeoutMs: this.timeoutMs,
      task: async (signal) => {
        const caller = await this.caller();
        const response = await caller.request(
          HUNK_SESSION_API_PATH,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
            signal,
          },
          { targetSpecific: input.action !== "list" },
        );
        if (!response.ok) throw new Error(await extractResponseError(response));
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          throw new Error(`Invalid Hunk session daemon response for ${input.action}.`);
        }
        return parseSessionDaemonResponse(input.action, value);
      },
    });
  }

  async getCapabilities() {
    return withSessionDaemonHttpTimeout({
      operation: "report capabilities",
      timeoutMs: this.timeoutMs,
      task: async (signal) => {
        const response = await (
          await this.caller()
        ).request(HUNK_SESSION_CAPABILITIES_PATH, {
          method: "GET",
          signal,
        });
        if (!response.ok) return null;
        return parseSessionDaemonCapabilities(await response.json());
      },
    });
  }

  async listSessions() {
    return (await this.request({ action: "list" })).sessions;
  }

  async getSession(selector: SessionSelectorInput) {
    return (await this.request({ action: "get", selector })).session;
  }

  async getSelectedContext(selector: SessionSelectorInput) {
    return (await this.request({ action: "context", selector })).context;
  }

  async getSessionReview(input: SessionReviewCommandInput) {
    return (
      await this.request({
        action: "review",
        selector: input.selector,
        includePatch: input.includePatch,
        includeNotes: input.includeNotes,
      })
    ).review;
  }

  async navigateToHunk(input: SessionNavigateCommandInput) {
    return (
      await this.request({
        action: "navigate",
        selector: input.selector,
        filePath: input.filePath,
        hunkNumber: input.hunkNumber,
        side: input.side,
        line: input.line,
        commentDirection: input.commentDirection,
        commentId: input.commentId,
      })
    ).result;
  }

  async reloadSession(input: SessionReloadCommandInput) {
    return (
      await this.request({
        action: "reload",
        selector: input.selector,
        nextInput: input.nextInput,
        sourcePath: input.sourcePath,
      })
    ).result;
  }

  async addComment(input: SessionCommentAddCommandInput) {
    return (
      await this.request({
        action: "comment-add",
        selector: input.selector,
        filePath: input.filePath,
        side: input.side,
        line: input.line,
        summary: input.summary,
        rationale: input.rationale,
        markup: input.markup,
        author: input.author,
        reveal: input.reveal,
      })
    ).result;
  }

  async applyComments(input: SessionCommentApplyCommandInput) {
    return (
      await this.request({
        action: "comment-apply",
        selector: input.selector,
        comments: input.comments,
        revealMode: input.revealMode,
      })
    ).result;
  }

  async listComments(input: SessionCommentListCommandInput) {
    return (
      await this.request({
        action: "comment-list",
        selector: input.selector,
        filePath: input.filePath,
        type: input.type,
      })
    ).comments;
  }

  async removeComment(input: SessionCommentRemoveCommandInput) {
    return (
      await this.request({
        action: "comment-rm",
        selector: input.selector,
        commentId: input.commentId,
      })
    ).result;
  }

  async clearComments(input: SessionCommentClearCommandInput) {
    return (
      await this.request({
        action: "comment-clear",
        selector: input.selector,
        filePath: input.filePath,
        includeUser: input.includeUser,
      })
    ).result;
  }

  async addHighlight(input: SessionHighlightAddCommandInput) {
    return (
      await this.request({
        action: "highlight-add",
        selector: input.selector,
        filePath: input.filePath,
        side: input.side,
        line: input.line,
        start: input.start,
        end: input.end,
        tone: input.tone,
        reveal: input.reveal,
      })
    ).result;
  }

  async clearHighlights(input: SessionHighlightClearCommandInput) {
    return (
      await this.request({
        action: "highlight-clear",
        selector: input.selector,
        filePath: input.filePath,
      })
    ).result;
  }
}

/** Create the concrete Hunk session CLI client that speaks to the broker-backed HTTP API. */
export function createHttpHunkSessionCliClient({
  timeoutMs,
  caller,
}: { timeoutMs?: number; caller?: HunkCallerTransport } = {}): HunkSessionCliClient {
  return new HttpHunkSessionCliClient(timeoutMs, caller);
}

export function stringifyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatSelectedSummary(session: ListedSession) {
  const filePath = session.snapshot.state.selectedFilePath
    ? formatSessionPath(session.snapshot.state.selectedFilePath)
    : "(none)";
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
        `${session.sessionId}  ${formatSessionPath(session.title)}`,
        `  path: ${formatSessionPath(session.cwd)}`,
        `  repo: ${session.repoRoot ? formatSessionPath(session.repoRoot) : "-"}`,
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

/** Keep exact session paths in JSON while neutralizing controls in human-readable output. */
function formatSessionPath(path: string) {
  return sanitizeTerminalText(path, { preserveNewlines: false, preserveTabs: false });
}

/** Sanitize selectors because session-path targets can contain arbitrary filesystem characters. */
function formatSessionSelector(selector: SessionSelectorInput) {
  return formatSessionPath(describeSessionSelector(selector));
}

export function formatSessionOutput(session: ListedSession) {
  const terminal = session.terminal;

  return [
    `Session: ${session.sessionId}`,
    `Title: ${formatSessionPath(session.title)}`,
    `Source: ${formatSessionPath(session.sourceLabel)}`,
    `Path: ${formatSessionPath(session.cwd)}`,
    `Repo: ${session.repoRoot ? formatSessionPath(session.repoRoot) : "-"}`,
    `Input: ${session.inputKind}`,
    ...((session.experimentalFeatures?.length ?? 0) > 0
      ? [`Experimental features: ${session.experimentalFeatures!.join(", ")}`]
      : []),
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
        `  - ${formatSessionPath(file.path)} (+${file.additions} -${file.deletions}, hunks: ${file.hunkCount})`,
    ),
    "",
  ].join("\n");
}

export function formatContextOutput(context: SelectedSessionContext) {
  const selectedFile = context.selectedFile?.path
    ? formatSessionPath(context.selectedFile.path)
    : "(none)";
  const hunkNumber = context.selectedHunk ? context.selectedHunk.index + 1 : 0;
  const oldRange = context.selectedHunk?.oldRange
    ? `${context.selectedHunk.oldRange[0]}..${context.selectedHunk.oldRange[1]}`
    : "-";
  const newRange = context.selectedHunk?.newRange
    ? `${context.selectedHunk.newRange[0]}..${context.selectedHunk.newRange[1]}`
    : "-";

  return [
    `Session: ${context.sessionId}`,
    `Title: ${formatSessionPath(context.title)}`,
    `Path: ${context.cwd ? formatSessionPath(context.cwd) : "-"}`,
    `Repo: ${context.repoRoot ? formatSessionPath(context.repoRoot) : "-"}`,
    `File: ${selectedFile}`,
    `Hunk: ${context.selectedHunk ? hunkNumber : "-"}`,
    `Old range: ${oldRange}`,
    `New range: ${newRange}`,
    `Agent notes visible: ${context.showAgentNotes ? "yes" : "no"}`,
    ...(context.experimentalFeatures?.includes("stml")
      ? [
          `Experimental features: ${context.experimentalFeatures.join(", ")}`,
          `Note markup width: ${context.noteMarkupWidth ?? "-"}`,
        ]
      : []),
    `Live comments: ${context.liveCommentCount}`,
    "",
  ].join("\n");
}

/** Render one human-readable summary of the exported live session review model. */
export function formatReviewOutput(review: SessionReview) {
  const selectedFile = review.selectedFile?.path
    ? formatSessionPath(review.selectedFile.path)
    : "(none)";
  const hunkNumber = review.selectedHunk ? review.selectedHunk.index + 1 : "-";

  return [
    `Session: ${review.sessionId}`,
    `Title: ${formatSessionPath(review.title)}`,
    `Source: ${formatSessionPath(review.sourceLabel)}`,
    `Path: ${review.cwd ? formatSessionPath(review.cwd) : "-"}`,
    `Repo: ${review.repoRoot ? formatSessionPath(review.repoRoot) : "-"}`,
    `Input: ${review.inputKind}`,
    ...((review.experimentalFeatures?.length ?? 0) > 0
      ? [`Experimental features: ${review.experimentalFeatures!.join(", ")}`]
      : []),
    `Selected file: ${selectedFile}`,
    `Selected hunk: ${hunkNumber}`,
    `Agent notes visible: ${review.showAgentNotes ? "yes" : "no"}`,
    `Live comments: ${review.liveCommentCount}`,
    `Review notes: ${review.reviewNoteCount ?? review.reviewNotes?.length ?? 0}`,
    ...(review.reviewNotes
      ? [
          "Notes:",
          ...review.reviewNotes.map(
            (note) =>
              `  - ${note.noteId} [${note.source}] ${formatSessionPath(note.filePath)}: ${note.body}`,
          ),
        ]
      : []),
    "Files:",
    ...review.files.flatMap((file) => [
      `  - ${formatSessionPath(file.path)} (+${file.additions} -${file.deletions}, hunks: ${file.hunkCount})`,
      ...file.hunks.map((hunk) => `      hunk ${hunk.index + 1}: ${hunk.header}`),
    ]),
    "",
  ].join("\n");
}

export function formatNavigationOutput(
  selector: SessionSelectorInput,
  result: NavigatedSelectionResult,
) {
  if (result.revealed === "line" && result.line !== undefined) {
    return `Revealed ${formatSessionPath(result.filePath)}:${result.line} (${result.side}) in hunk ${result.hunkIndex + 1} of ${formatSessionSelector(selector)}.\n`;
  }

  return `Focused ${formatSessionPath(result.filePath)} hunk ${result.hunkIndex + 1} in ${formatSessionSelector(selector)}.\n`;
}

export function formatReloadOutput(selector: SessionSelectorInput, result: ReloadedSessionResult) {
  const selected = result.selectedFilePath
    ? `${formatSessionPath(result.selectedFilePath)} hunk ${result.selectedHunkIndex + 1}`
    : "(no files)";
  return `Reloaded ${formatSessionSelector(selector)} with ${formatSessionPath(result.title)} (${result.fileCount} files). Selected: ${selected}.\n`;
}

/** Format the STML render notes attached to one applied comment, if any. */
function formatMarkupNotes(result: AppliedCommentResult, indent = "") {
  const widthHint =
    result.markupWidth !== undefined
      ? ` (preview with \`hunk markup render - --width ${result.markupWidth}\`)`
      : " (preview with `hunk markup render`)";
  return (result.markupNotes ?? []).map((note) => `${indent}Markup note: ${note}${widthHint}.`);
}

export function formatCommentOutput(selector: SessionSelectorInput, result: AppliedCommentResult) {
  return `${[
    `Added live comment ${result.commentId} on ${formatSessionPath(result.filePath)}:${result.line} (${result.side}) in hunk ${result.hunkIndex + 1} for ${formatSessionSelector(selector)}.`,
    ...formatMarkupNotes(result),
  ].join("\n")}\n`;
}

export function formatCommentApplyOutput(
  selector: SessionSelectorInput,
  result: AppliedCommentBatchResult,
) {
  if (result.applied.length === 0) {
    return `Applied 0 live comments to ${formatSessionSelector(selector)}.\n`;
  }

  return `${[
    `Applied ${result.applied.length} live comments to ${formatSessionSelector(selector)}:`,
    ...result.applied.flatMap((comment) => [
      `  - ${comment.commentId} on ${formatSessionPath(comment.filePath)}:${comment.line} (${comment.side}) hunk ${comment.hunkIndex + 1}`,
      ...formatMarkupNotes(comment, "    "),
    ]),
    "",
  ].join("\n")}`;
}

export function formatCommentListOutput(
  selector: SessionSelectorInput,
  comments: SessionLiveCommentSummary[],
) {
  if (comments.length === 0) {
    return `No live comments for ${formatSessionSelector(selector)}.\n`;
  }

  return `${comments
    .map((comment) =>
      [
        `${comment.commentId}  ${formatSessionPath(comment.filePath)}:${comment.line} (${comment.side})`,
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
  const label = result.source === "user" ? "user note" : "live comment";
  return `Removed ${label} ${result.commentId} from ${formatSessionSelector(selector)}. Remaining comments: ${result.remainingCommentCount}.\n`;
}

export function formatNoteListOutput(
  selector: SessionSelectorInput,
  notes: SessionReviewNoteSummary[],
) {
  if (notes.length === 0) {
    return `No review notes for ${formatSessionSelector(selector)}.\n`;
  }

  return `${notes
    .map((note) =>
      [
        `${note.noteId}  ${formatSessionPath(note.filePath)} [${note.source}]`,
        ...(note.hunkIndex !== undefined ? [`  hunk: ${note.hunkIndex + 1}`] : []),
        `  body: ${note.body}`,
        ...(note.author ? [`  author: ${note.author}`] : []),
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

/**
 * Report one applied attention mark, including whether the review moved to it.
 *
 * The running mark count is part of the answer because marks accumulate per
 * file: an agent that keeps marking needs to see its own total without asking.
 */
export function formatHighlightOutput(
  selector: SessionSelectorInput,
  result: AppliedHighlightResult,
) {
  const reveal =
    result.revealed === "line"
      ? " and revealed its line"
      : result.revealed === "hunk"
        ? " and revealed its hunk"
        : "";
  return (
    `Marked ${formatSessionPath(result.filePath)}:${result.line} (${result.side}) ` +
    `[${result.start}, ${result.end}) as ${result.tone} in ${formatSessionSelector(selector)}${reveal}. ` +
    `File marks: ${result.fileMarkCount}.\n`
  );
}

/**
 * Report how many attention marks were cleared, and from what scope.
 *
 * Clearing is addressed either to one file or to the whole session, so the
 * scope is named back to the caller rather than assumed.
 */
export function formatClearHighlightsOutput(
  selector: SessionSelectorInput,
  result: ClearedHighlightsResult,
) {
  const scope = result.filePath
    ? `${formatSessionPath(result.filePath)} in ${formatSessionSelector(selector)}`
    : formatSessionSelector(selector);
  return `Cleared ${result.removedCount} attention marks from ${scope}. Remaining marks: ${result.remainingCount}.\n`;
}

export function formatClearCommentsOutput(
  selector: SessionSelectorInput,
  result: ClearedCommentsResult,
) {
  const scope = result.filePath
    ? `${formatSessionPath(result.filePath)} in ${formatSessionSelector(selector)}`
    : formatSessionSelector(selector);
  const label = result.includeUser ? "comments" : "live comments";
  return `Cleared ${result.removedCount} ${label} from ${scope}. Remaining comments: ${result.remainingCommentCount}.\n`;
}
