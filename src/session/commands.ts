import { resolve } from "node:path";
import type {
  SessionCommandInput,
  SessionCommandOutput,
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
import {
  ensureHunkDaemonAvailable,
  isHunkDaemonHealthy,
  isLoopbackPortReachable,
  readHunkDaemonHealth,
  waitForHunkDaemonShutdown,
} from "../mcp/daemonLauncher";
import { resolveHunkMcpConfig } from "../mcp/config";
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
  SessionTerminalLocation,
  SessionTerminalMetadata,
} from "../mcp/types";
import { readHunkSessionDaemonCapabilities, reportHunkDaemonUpgradeRestart } from "./capabilities";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
} from "./protocol";

export interface HunkDaemonCliClient {
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

const REQUIRED_ACTION_BY_COMMAND: Record<SessionCommandInput["action"], SessionDaemonAction> = {
  list: "list",
  get: "get",
  context: "context",
  review: "review",
  navigate: "navigate",
  reload: "reload",
  "comment-add": "comment-add",
  "comment-apply": "comment-apply",
  "comment-list": "comment-list",
  "comment-rm": "comment-rm",
  "comment-clear": "comment-clear",
};

interface SessionCommandTestHooks {
  createClient?: () => HunkDaemonCliClient;
  resolveDaemonAvailability?: (action: SessionCommandInput["action"]) => Promise<boolean>;
  restartDaemonForMissingAction?: (
    action: SessionDaemonAction,
    selector?: SessionSelectorInput,
  ) => Promise<void>;
}

let sessionCommandTestHooks: SessionCommandTestHooks | null = null;

export function setSessionCommandTestHooks(hooks: SessionCommandTestHooks | null) {
  sessionCommandTestHooks = hooks;
}

function createDaemonCliClient() {
  return sessionCommandTestHooks?.createClient?.() ?? new HttpHunkDaemonCliClient();
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

class HttpHunkDaemonCliClient implements HunkDaemonCliClient {
  private readonly config = resolveHunkMcpConfig();

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

function sessionMatchesSelector(session: ListedSession, selector?: SessionSelectorInput) {
  if (!selector) {
    return true;
  }

  if (selector.sessionId) {
    return session.sessionId === selector.sessionId;
  }

  const sessionPath = selector?.sessionPath;
  if (sessionPath) {
    return session.cwd === sessionPath;
  }

  if (selector.repoRoot) {
    return session.repoRoot === selector.repoRoot;
  }

  return true;
}

async function waitForSessionRegistration(selector?: SessionSelectorInput, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const client = createDaemonCliClient();

    try {
      const sessions = await client.listSessions();
      if (sessions.some((session) => sessionMatchesSelector(session, selector))) {
        return true;
      }
    } catch {
      // Keep polling while the fresh daemon/session reconnects.
    }

    await Bun.sleep(200);
  }

  return false;
}

async function restartDaemonForMissingAction(
  action: SessionDaemonAction,
  selector?: SessionSelectorInput,
) {
  const health = await readHunkDaemonHealth();
  const pid = health?.pid;
  const hadSessions = (health?.sessions ?? 0) > 0;
  if (!pid || pid === process.pid) {
    throw new Error(
      `The running Hunk session daemon is missing required support for ${action}. ` +
        `Restart Hunk so it can launch a fresh daemon from the current source tree.`,
    );
  }

  process.kill(pid, "SIGTERM");

  const shutDown = await waitForHunkDaemonShutdown();
  if (!shutDown) {
    throw new Error(
      `Stopped waiting for the old Hunk session daemon to exit after it was found missing ${action}.`,
    );
  }

  const config = resolveHunkMcpConfig();
  await ensureHunkDaemonAvailable({
    config,
    timeoutMs: 3_000,
    timeoutMessage: "Timed out waiting for the refreshed Hunk session daemon to start.",
  });

  // `hunk session list` can recover from a stale daemon even when the old process belonged to a
  // sibling worktree that reports sessions which will never reconnect to this fresh daemon.
  if (selector || (hadSessions && action !== "list")) {
    const registered = await waitForSessionRegistration(selector);
    if (!registered) {
      throw new Error(
        "Timed out waiting for the live Hunk session to reconnect after refreshing the session daemon. " +
          "Restart that Hunk window if it was launched from an older build.",
      );
    }
  }
}

async function ensureRequiredAction(action: SessionDaemonAction, selector?: SessionSelectorInput) {
  const client = createDaemonCliClient();
  const capabilities = await client.getCapabilities();
  if (capabilities?.version === HUNK_SESSION_API_VERSION && capabilities.actions.includes(action)) {
    return;
  }

  reportHunkDaemonUpgradeRestart();
  await (sessionCommandTestHooks?.restartDaemonForMissingAction?.(action, selector) ??
    restartDaemonForMissingAction(action, selector));
}

function stringifyJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatSelector(selector: SessionSelectorInput) {
  if (selector.sessionId) {
    return `session ${selector.sessionId}`;
  }

  if (selector.sessionPath) {
    return `session path ${selector.sessionPath}`;
  }

  if (selector.repoRoot) {
    return `repo ${selector.repoRoot}`;
  }

  return "session";
}

function formatSelectedSummary(session: ListedSession) {
  const filePath = session.snapshot.selectedFilePath ?? "(none)";
  const hunkNumber = session.snapshot.selectedFilePath ? session.snapshot.selectedHunkIndex + 1 : 0;
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

function resolveSessionTerminal(session: ListedSession) {
  return session.terminal;
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

function formatListOutput(sessions: ListedSession[]) {
  if (sessions.length === 0) {
    return "No active Hunk sessions.\n";
  }

  return `${sessions
    .map((session) => {
      const terminal = resolveSessionTerminal(session);
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
        `  comments: ${session.snapshot.liveCommentCount}`,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

function formatSessionOutput(session: ListedSession) {
  const terminal = resolveSessionTerminal(session);

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
    `Agent notes visible: ${session.snapshot.showAgentNotes ? "yes" : "no"}`,
    `Live comments: ${session.snapshot.liveCommentCount}`,
    "Files:",
    ...session.files.map(
      (file) =>
        `  - ${file.path} (+${file.additions} -${file.deletions}, hunks: ${file.hunkCount})`,
    ),
    "",
  ].join("\n");
}

function formatContextOutput(context: SelectedSessionContext) {
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
function formatReviewOutput(review: SessionReview) {
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

function formatNavigationOutput(selector: SessionSelectorInput, result: NavigatedSelectionResult) {
  return `Focused ${result.filePath} hunk ${result.hunkIndex + 1} in ${formatSelector(selector)}.\n`;
}

function formatReloadOutput(selector: SessionSelectorInput, result: ReloadedSessionResult) {
  const selected = result.selectedFilePath
    ? `${result.selectedFilePath} hunk ${result.selectedHunkIndex + 1}`
    : "(no files)";
  return `Reloaded ${formatSelector(selector)} with ${result.title} (${result.fileCount} files). Selected: ${selected}.\n`;
}

function formatCommentOutput(selector: SessionSelectorInput, result: AppliedCommentResult) {
  return `Added live comment ${result.commentId} on ${result.filePath}:${result.line} (${result.side}) in hunk ${result.hunkIndex + 1} for ${formatSelector(selector)}.\n`;
}

function formatCommentApplyOutput(
  selector: SessionSelectorInput,
  result: AppliedCommentBatchResult,
) {
  if (result.applied.length === 0) {
    return `Applied 0 live comments to ${formatSelector(selector)}.\n`;
  }

  return `${[
    `Applied ${result.applied.length} live comments to ${formatSelector(selector)}:`,
    ...result.applied.map(
      (comment) =>
        `  - ${comment.commentId} on ${comment.filePath}:${comment.line} (${comment.side}) hunk ${comment.hunkIndex + 1}`,
    ),
    "",
  ].join("\n")}`;
}

function formatCommentListOutput(
  selector: SessionSelectorInput,
  comments: SessionLiveCommentSummary[],
) {
  if (comments.length === 0) {
    return `No live comments for ${formatSelector(selector)}.\n`;
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

function formatRemoveCommentOutput(selector: SessionSelectorInput, result: RemovedCommentResult) {
  return `Removed live comment ${result.commentId} from ${formatSelector(selector)}. Remaining comments: ${result.remainingCommentCount}.\n`;
}

function formatClearCommentsOutput(selector: SessionSelectorInput, result: ClearedCommentsResult) {
  const scope = result.filePath
    ? `${result.filePath} in ${formatSelector(selector)}`
    : formatSelector(selector);
  return `Cleared ${result.removedCount} live comments from ${scope}. Remaining comments: ${result.remainingCommentCount}.\n`;
}

function normalizeSessionSelector(selector: SessionSelectorInput) {
  return {
    ...selector,
    sessionPath: selector.sessionPath ? resolve(selector.sessionPath) : undefined,
    repoRoot: selector.repoRoot ? resolve(selector.repoRoot) : undefined,
  };
}

async function resolveDaemonAvailability(action: SessionCommandInput["action"]) {
  const config = resolveHunkMcpConfig();
  const healthy = await isHunkDaemonHealthy(config);
  if (healthy) {
    return true;
  }

  const portReachable = await isLoopbackPortReachable(config);
  if (portReachable) {
    throw new Error(
      `Hunk MCP port ${config.host}:${config.port} is already in use by another process. ` +
        `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
    );
  }

  if (action === "list") {
    return false;
  }

  throw new Error(
    "No active Hunk sessions are registered with the daemon. Open Hunk and wait for it to connect.",
  );
}

function renderOutput(output: SessionCommandOutput, value: unknown, formatText: () => string) {
  return output === "json" ? stringifyJson(value) : formatText();
}

export async function runSessionCommand(input: SessionCommandInput) {
  const daemonAvailable = await (sessionCommandTestHooks?.resolveDaemonAvailability?.(
    input.action,
  ) ?? resolveDaemonAvailability(input.action));
  if (!daemonAvailable && input.action === "list") {
    return renderOutput(input.output, { sessions: [] }, () => formatListOutput([]));
  }

  const normalizedSelector = "selector" in input ? normalizeSessionSelector(input.selector) : null;
  await ensureRequiredAction(
    REQUIRED_ACTION_BY_COMMAND[input.action],
    normalizedSelector ?? undefined,
  );

  const client = createDaemonCliClient();

  switch (input.action) {
    case "list": {
      const sessions = await client.listSessions();
      return renderOutput(input.output, { sessions }, () => formatListOutput(sessions));
    }
    case "get": {
      const session = await client.getSession(normalizedSelector!);
      return renderOutput(input.output, { session }, () => formatSessionOutput(session));
    }
    case "context": {
      const context = await client.getSelectedContext(normalizedSelector!);
      return renderOutput(input.output, { context }, () => formatContextOutput(context));
    }
    case "review": {
      const review = await client.getSessionReview({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { review }, () => formatReviewOutput(review));
    }
    case "navigate": {
      const result = await client.navigateToHunk({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatNavigationOutput(input.selector, result),
      );
    }
    case "reload": {
      const result = await client.reloadSession({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatReloadOutput(input.selector, result),
      );
    }
    case "comment-add": {
      const result = await client.addComment({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatCommentOutput(input.selector, result),
      );
    }
    case "comment-apply": {
      const result = await client.applyComments({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatCommentApplyOutput(input.selector, result),
      );
    }
    case "comment-list": {
      const comments = await client.listComments({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { comments }, () =>
        formatCommentListOutput(input.selector, comments),
      );
    }
    case "comment-rm": {
      const result = await client.removeComment({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatRemoveCommentOutput(input.selector, result),
      );
    }
    case "comment-clear": {
      const result = await client.clearComments({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatClearCommentsOutput(input.selector, result),
      );
    }
  }
}
