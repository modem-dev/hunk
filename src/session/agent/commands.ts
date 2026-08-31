import type { SessionCommandInput, SessionCommandOutput } from "../../core/run/commandInputs";
import type { SessionLiveCommentSummary, SessionReviewNoteSummary } from "../types";
import { NO_ACTIVE_SESSIONS_MESSAGE } from "./errors";
import { isSessionBrokerHealthy, isLoopbackPortReachable } from "../broker/brokerLauncher";
import { resolveSessionBrokerConfig } from "../broker/brokerConfig";
import { normalizeSessionSelector } from "@hunk/session-broker-core";
import { SessionBrokerClientAuthenticationError } from "@hunk/session-broker";
import {
  createHttpHunkSessionCliClient,
  formatClearCommentsOutput,
  formatClearHighlightsOutput,
  formatCommentApplyOutput,
  formatCommentListOutput,
  formatCommentOutput,
  formatContextOutput,
  formatHighlightOutput,
  formatListOutput,
  formatNavigationOutput,
  formatNoteListOutput,
  formatReloadOutput,
  formatRemoveCommentOutput,
  formatReviewOutput,
  formatSessionOutput,
  stringifyJson,
  type HunkSessionCliClient,
} from "./cliClient";
import { HUNK_SESSION_API_VERSION, type SessionDaemonAction } from "../protocol";

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
  "highlight-add": "highlight-add",
  "highlight-clear": "highlight-clear",
};

export type HunkDaemonCliClient = HunkSessionCliClient;

interface SessionCommandTestHooks {
  createClient?: () => HunkSessionCliClient;
  resolveDaemonAvailability?: (action: SessionCommandInput["action"]) => Promise<boolean>;
}

let sessionCommandTestHooks: SessionCommandTestHooks | null = null;

export function setSessionCommandTestHooks(hooks: SessionCommandTestHooks | null) {
  sessionCommandTestHooks = hooks;
}

function createDaemonCliClient() {
  return sessionCommandTestHooks?.createClient?.() ?? createHttpHunkSessionCliClient();
}

async function ensureRequiredAction(action: SessionDaemonAction, client = createDaemonCliClient()) {
  let capabilities;
  try {
    capabilities = await client.getCapabilities();
  } catch (error) {
    if (!(error instanceof SessionBrokerClientAuthenticationError)) throw error;
    capabilities = null;
  }
  if (capabilities?.version === HUNK_SESSION_API_VERSION && capabilities.actions.includes(action)) {
    return;
  }

  throw new Error(
    `The running Hunk session daemon is incompatible or missing required support for ${action}. ` +
      "Close older Hunk windows, wait for the daemon to become idle, then retry this command.",
  );
}

async function resolveDaemonAvailability(action: SessionCommandInput["action"]) {
  const config = resolveSessionBrokerConfig();
  const healthy = await isSessionBrokerHealthy(config);
  if (healthy) {
    return true;
  }

  const portReachable = await isLoopbackPortReachable(config);
  if (portReachable) {
    throw new Error(
      `Hunk session daemon port ${config.host}:${config.port} is already in use by another process. ` +
        `Stop the conflicting process or set HUNK_MCP_PORT to a different loopback port.`,
    );
  }

  if (action === "list") {
    return false;
  }

  throw new Error(NO_ACTIVE_SESSIONS_MESSAGE);
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
  const requiredAction = REQUIRED_ACTION_BY_COMMAND[input.action];
  const client = createDaemonCliClient();
  await ensureRequiredAction(requiredAction, client);

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

      if (input.type && input.type !== "live") {
        const notes = comments as SessionReviewNoteSummary[];
        return renderOutput(input.output, { comments: notes }, () =>
          formatNoteListOutput(input.selector, notes),
        );
      }

      return renderOutput(input.output, { comments }, () =>
        formatCommentListOutput(input.selector, comments as SessionLiveCommentSummary[]),
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
    case "highlight-add": {
      const result = await client.addHighlight({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatHighlightOutput(input.selector, result),
      );
    }
    case "highlight-clear": {
      const result = await client.clearHighlights({
        ...input,
        selector: normalizedSelector!,
      });
      return renderOutput(input.output, { result }, () =>
        formatClearHighlightsOutput(input.selector, result),
      );
    }
  }
}
