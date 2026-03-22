import { resolve } from "node:path";
import type {
  SessionCommandInput,
  SessionCommandOutput,
  SessionCommentAddCommandInput,
  SessionCommentClearCommandInput,
  SessionCommentListCommandInput,
  SessionCommentRemoveCommandInput,
  SessionNavigateCommandInput,
  SessionSelectorInput,
} from "../core/types";
import {
  isHunkDaemonHealthy,
  isLoopbackPortReachable,
  launchHunkDaemon,
  waitForHunkDaemonHealth,
} from "../mcp/daemonLauncher";
import { resolveHunkMcpConfig } from "../mcp/config";
import type {
  AppliedCommentResult,
  ClearedCommentsResult,
  ListedSession,
  NavigatedSelectionResult,
  RemovedCommentResult,
  SelectedSessionContext,
  SessionLiveCommentSummary,
} from "../mcp/types";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_CAPABILITIES_PATH,
  type SessionDaemonAction,
  type SessionDaemonCapabilities,
  type SessionDaemonRequest,
} from "./protocol";

export interface HunkDaemonCliClient {
  getCapabilities(): Promise<SessionDaemonCapabilities | null>;
  listSessions(): Promise<ListedSession[]>;
  getSession(selector: SessionSelectorInput): Promise<ListedSession>;
  getSelectedContext(selector: SessionSelectorInput): Promise<SelectedSessionContext>;
  navigateToHunk(input: SessionNavigateCommandInput): Promise<NavigatedSelectionResult>;
  addComment(input: SessionCommentAddCommandInput): Promise<AppliedCommentResult>;
  listComments(input: SessionCommentListCommandInput): Promise<SessionLiveCommentSummary[]>;
  removeComment(input: SessionCommentRemoveCommandInput): Promise<RemovedCommentResult>;
  clearComments(input: SessionCommentClearCommandInput): Promise<ClearedCommentsResult>;
}

const REQUIRED_ACTION_BY_COMMAND: Record<SessionCommandInput["action"], SessionDaemonAction> = {
  list: "list",
  get: "get",
  context: "context",
  navigate: "navigate",
  "comment-add": "comment-add",
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
    const response = await fetch(`${this.config.httpOrigin}${HUNK_SESSION_CAPABILITIES_PATH}`);
    if (response.status === 404 || response.status === 410) {
      return null;
    }

    if (!response.ok) {
      throw new Error(await extractResponseError(response));
    }

    const capabilities = (await response.json()) as SessionDaemonCapabilities;
    if (capabilities.version !== HUNK_SESSION_API_VERSION || !Array.isArray(capabilities.actions)) {
      throw new Error("The Hunk session daemon returned an invalid capabilities payload.");
    }

    return capabilities;
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

  async navigateToHunk(input: SessionNavigateCommandInput) {
    return (
      await this.request<{ result: NavigatedSelectionResult }>({
        action: "navigate",
        selector: input.selector,
        filePath: input.filePath,
        hunkNumber: input.hunkNumber,
        side: input.side,
        line: input.line,
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

async function readDaemonHealth() {
  const config = resolveHunkMcpConfig();

  try {
    const response = await fetch(`${config.httpOrigin}/health`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as {
      ok: boolean;
      pid?: number;
      sessions?: number;
    };
  } catch {
    return null;
  }
}

async function waitForDaemonShutdown(timeoutMs = 3_000) {
  const config = resolveHunkMcpConfig();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isHunkDaemonHealthy(config))) {
      return true;
    }

    await Bun.sleep(100);
  }

  return false;
}

function sessionMatchesSelector(session: ListedSession, selector?: SessionSelectorInput) {
  if (!selector) {
    return true;
  }

  if (selector.sessionId) {
    return session.sessionId === selector.sessionId;
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
  const health = await readDaemonHealth();
  const pid = health?.pid;
  const hadSessions = (health?.sessions ?? 0) > 0;
  if (!pid || pid === process.pid) {
    throw new Error(
      `The running Hunk session daemon is missing required support for ${action}. ` +
        `Restart Hunk so it can launch a fresh daemon from the current source tree.`,
    );
  }

  process.kill(pid, "SIGTERM");

  const shutDown = await waitForDaemonShutdown();
  if (!shutDown) {
    throw new Error(
      `Stopped waiting for the old Hunk session daemon to exit after it was found missing ${action}.`,
    );
  }

  launchHunkDaemon();

  const config = resolveHunkMcpConfig();
  const ready = await waitForHunkDaemonHealth({ config, timeoutMs: 3_000 });
  if (!ready) {
    throw new Error("Timed out waiting for the refreshed Hunk session daemon to start.");
  }

  if (selector || hadSessions) {
    const registered = await waitForSessionRegistration(selector);
    if (!registered) {
      throw new Error(
        "Timed out waiting for the live Hunk session to reconnect after refreshing the session daemon.",
      );
    }
  }
}

async function ensureRequiredAction(action: SessionDaemonAction, selector?: SessionSelectorInput) {
  const client = createDaemonCliClient();
  const capabilities = await client.getCapabilities();
  if (capabilities?.actions.includes(action)) {
    return;
  }

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

function formatListOutput(sessions: ListedSession[]) {
  if (sessions.length === 0) {
    return "No active Hunk sessions.\n";
  }

  return `${sessions
    .map((session) =>
      [
        `${session.sessionId}  ${session.title}`,
        `  repo: ${session.repoRoot ?? session.cwd}`,
        `  focus: ${formatSelectedSummary(session)}`,
        `  files: ${session.fileCount}`,
        `  comments: ${session.snapshot.liveCommentCount}`,
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

function formatSessionOutput(session: ListedSession) {
  return [
    `Session: ${session.sessionId}`,
    `Title: ${session.title}`,
    `Source: ${session.sourceLabel}`,
    `Repo: ${session.repoRoot ?? session.cwd}`,
    `Input: ${session.inputKind}`,
    `Launched: ${session.launchedAt}`,
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

function formatNavigationOutput(selector: SessionSelectorInput, result: NavigatedSelectionResult) {
  return `Focused ${result.filePath} hunk ${result.hunkIndex + 1} in ${formatSelector(selector)}.\n`;
}

function formatCommentOutput(selector: SessionSelectorInput, result: AppliedCommentResult) {
  return `Added live comment ${result.commentId} on ${result.filePath}:${result.line} (${result.side}) in hunk ${result.hunkIndex + 1} for ${formatSelector(selector)}.\n`;
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

function normalizeRepoRoot(selector: SessionSelectorInput) {
  if (!selector.repoRoot) {
    return selector;
  }

  return {
    ...selector,
    repoRoot: resolve(selector.repoRoot),
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

  const normalizedSelector = "selector" in input ? normalizeRepoRoot(input.selector) : null;
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
    case "navigate": {
      const result = await client.navigateToHunk({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatNavigationOutput(input.selector, result),
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
