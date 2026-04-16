import type {
  SessionCommandInput,
  SessionCommandOutput,
  SessionSelectorInput,
} from "../core/types";
import {
  ensureSessionBrokerAvailable,
  isSessionBrokerHealthy,
  isLoopbackPortReachable,
  readSessionBrokerHealth,
  waitForSessionBrokerShutdown,
} from "../session-broker/brokerLauncher";
import { resolveSessionBrokerConfig } from "../session-broker/brokerConfig";
import { matchesSessionSelector, normalizeSessionSelector } from "@hunk/session-broker-core";
import {
  createHttpHunkSessionCliClient,
  formatClearCommentsOutput,
  formatCommentApplyOutput,
  formatCommentListOutput,
  formatCommentOutput,
  formatContextOutput,
  formatListOutput,
  formatNavigationOutput,
  formatReloadOutput,
  formatRemoveCommentOutput,
  formatReviewOutput,
  formatSessionOutput,
  stringifyJson,
  type HunkSessionCliClient,
} from "../hunk-session/cli";
import { reportHunkDaemonUpgradeRestart } from "./capabilities";
import { HUNK_SESSION_API_VERSION, type SessionDaemonAction } from "./protocol";

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

export type HunkDaemonCliClient = HunkSessionCliClient;

interface SessionCommandTestHooks {
  createClient?: () => HunkSessionCliClient;
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
  return sessionCommandTestHooks?.createClient?.() ?? createHttpHunkSessionCliClient();
}

async function waitForSessionRegistration(selector?: SessionSelectorInput, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const client = createDaemonCliClient();

    try {
      const sessions = await client.listSessions();
      if (sessions.some((session) => matchesSessionSelector(session, selector))) {
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
  const health = await readSessionBrokerHealth();
  const pid = health?.pid;
  const hadSessions = (health?.sessions ?? 0) > 0;
  if (!pid || pid === process.pid) {
    throw new Error(
      `The running Hunk session daemon is missing required support for ${action}. ` +
        `Restart Hunk so it can launch a fresh daemon from the current source tree.`,
    );
  }

  process.kill(pid, "SIGTERM");

  const shutDown = await waitForSessionBrokerShutdown();
  if (!shutDown) {
    throw new Error(
      `Stopped waiting for the old Hunk session daemon to exit after it was found missing ${action}.`,
    );
  }

  const config = resolveSessionBrokerConfig();
  await ensureSessionBrokerAvailable({
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
