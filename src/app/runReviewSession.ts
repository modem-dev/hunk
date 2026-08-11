import { HunkUserError } from "../core/errors";
import type { AppBootstrap, CliInput } from "../core/types";
import {
  assertSessionRegistrationEnvelopeWithinBounds,
  createSessionRegistration,
} from "../session/app/registration";
import { createSessionSnapshotFromReviewState } from "../session/app/reviewSnapshot";
import { SessionBrokerClient } from "../session/broker/brokerClient";
import {
  allowsUnsafeRemoteSessionBroker,
  isLoopbackHost,
  resolveSessionBrokerConfig,
} from "../session/broker/brokerConfig";
import { HUNK_SESSION_API_PATH } from "../session/protocol";
import { ReviewProducerCapacityError } from "../session/reviewProtocol";
import type {
  BrowserReviewUrlResult,
  HunkSessionBrokerClient,
  HunkSessionCommandResult,
  HunkSessionInfo,
  HunkSessionServerMessage,
  HunkSessionState,
} from "../session/types";
import type { ControllingTerminal } from "../core/terminal";
import { openBrowserUrl } from "./browserReview";
import { createReviewSessionRuntime } from "./reviewSessionRuntime";

export interface ReviewSessionInput {
  bootstrap: AppBootstrap;
  rawInput: CliInput;
  controllingTerminal: ControllingTerminal | null;
}

interface ReviewSessionCleanupOwners {
  hostClient?: Pick<HunkSessionBrokerClient, "stop">;
  controllingTerminal?: Pick<ControllingTerminal, "close"> | null;
  runtime: Pick<ReturnType<typeof createReviewSessionRuntime>, "shutdown">;
}

/** Attempt every outer review owner and preserve the first cleanup failure. */
export async function closeReviewSessionOwners({
  hostClient,
  controllingTerminal,
  runtime,
}: ReviewSessionCleanupOwners) {
  let firstError: unknown;
  let hasError = false;
  const attempt = async (cleanup: () => void | Promise<void>) => {
    try {
      await cleanup();
    } catch (error) {
      if (!hasError) firstError = error;
      hasError = true;
    }
  };

  await attempt(() => hostClient?.stop());
  await attempt(() => controllingTerminal?.close());
  await attempt(() => runtime.shutdown());
  if (hasError) throw firstError;
}

/** Clean all outer owners without replacing the failure that initiated teardown. */
async function rethrowAfterReviewCleanup(
  error: unknown,
  owners: ReviewSessionCleanupOwners,
): Promise<never> {
  try {
    await closeReviewSessionOwners(owners);
  } catch {
    // The original review failure remains authoritative after every cleanup has been attempted.
  }
  throw error;
}

/** Construct broker publication only after renderer selection confirms it is available. */
function createReviewHostClient(
  input: ReviewSessionInput,
  runtime: ReturnType<typeof createReviewSessionRuntime>,
) {
  const runtimeSnapshot = runtime.getSnapshot();
  const registration = createSessionRegistration(
    input.bootstrap,
    runtimeSnapshot.projection.document,
    { browserReviewCapabilityHash: runtime.getBrowserReviewCapabilityHash() },
  );
  const initialSnapshot = createSessionSnapshotFromReviewState(runtimeSnapshot.store.getSnapshot());
  assertSessionRegistrationEnvelopeWithinBounds(registration, initialSnapshot);
  const hostClient = new SessionBrokerClient<
    HunkSessionInfo,
    HunkSessionState,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  >(registration, initialSnapshot);
  runtime.attachHostClient(hostClient);
  return hostClient;
}

/** Prepare optional terminal publication without letting transport capacity block local review. */
export function prepareTerminalReviewBroker(
  input: ReviewSessionInput,
  runtime: ReturnType<typeof createReviewSessionRuntime>,
  disabled = process.env.HUNK_MCP_DISABLE === "1",
): { hostClient?: HunkSessionBrokerClient; sessionNotice?: string } {
  if (disabled) return {};
  try {
    return { hostClient: createReviewHostClient(input, runtime) };
  } catch (error) {
    if (!(error instanceof ReviewProducerCapacityError)) throw error;
    return {
      sessionNotice: "Session brokering is unavailable for this large review; reviewing locally.",
    };
  }
}

/** Wait until the producer registration and production browser route are both live. */
async function waitForBrowserReview(url: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  const shellUrl = new URL(url);
  shellUrl.hash = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(shellUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The daemon may still be starting or the producer websocket may still be registering.
    }
    await Bun.sleep(100);
  }

  throw new HunkUserError("Could not publish the browser review through the local Hunk daemon.", [
    "Check that the loopback daemon port is available, then retry.",
    "Set HUNK_MCP_PORT to another local port if the configured port is already in use.",
  ]);
}

/** Ask the loopback daemon to lazily enable Tailscale and issue its validated review origin. */
async function requestTailscaleBrowserUrl(
  config: ReturnType<typeof resolveSessionBrokerConfig>,
  sessionId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "session registration is not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${config.httpOrigin}${HUNK_SESSION_API_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "open", selector: { sessionId }, tailscale: true }),
        // Tailscale detection is bounded to three seconds in the daemon; leave enough time for
        // that actionable result to cross the loopback API instead of masking it as a retry.
        signal: AbortSignal.timeout(5_000),
      });
      const payload = (await response.json()) as {
        result?: BrowserReviewUrlResult;
        error?: string;
      };
      if (response.ok && payload.result?.url) return payload.result.url;
      lastError = payload.error ?? `daemon returned HTTP ${response.status}`;
      const registrationPending = lastError.startsWith(
        `No active session matches sessionId ${sessionId}.`,
      );
      if (!registrationPending) {
        throw new HunkUserError("Could not publish the browser review through Tailscale.", [
          lastError,
        ]);
      }
    } catch (error) {
      if (error instanceof HunkUserError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new HunkUserError("Could not publish the browser review through Tailscale.", [lastError]);
}

/** Keep a renderer-free browser-owned review alive until the owning process receives a signal. */
async function runWebReview(
  runtime: ReturnType<typeof createReviewSessionRuntime>,
  hostClient: HunkSessionBrokerClient,
  options: CliInput["options"],
) {
  try {
    const config = resolveSessionBrokerConfig();
    if (!isLoopbackHost(config.host) || allowsUnsafeRemoteSessionBroker()) {
      throw new HunkUserError(
        "Browser review is available only through Hunk's safe loopback daemon.",
        ["Use HUNK_MCP_HOST=127.0.0.1 and disable unsafe remote broker access."],
      );
    }

    hostClient.start();
    runtime.start();
    const sessionId = hostClient.getRegistration().sessionId;
    const url = options.tailscale
      ? await requestTailscaleBrowserUrl(config, sessionId)
      : runtime.getBrowserReviewUrl(config.httpOrigin);
    await waitForBrowserReview(url);
    if (options.openBrowser === false) {
      process.stdout.write(`${url}\n`);
    } else {
      await openBrowserUrl(url);
      process.stdout.write("Browser review opened.\n");
    }

    await new Promise<void>((resolve) => {
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const stop = () => {
        for (const signal of signals) process.off(signal, stop);
        resolve();
      };
      for (const signal of signals) process.once(signal, stop);
    });
  } catch (error) {
    return rethrowAfterReviewCleanup(error, { hostClient, runtime });
  }
  await closeReviewSessionOwners({ hostClient, runtime });
}

/** Select a renderer over one already-loaded review authority without duplicating bootstrap work. */
export async function runReviewSession(input: ReviewSessionInput): Promise<void> {
  const web = Boolean(input.bootstrap.input.options.web);
  if (web && process.env.HUNK_MCP_DISABLE === "1") {
    input.controllingTerminal?.close();
    throw new HunkUserError("Browser review requires the local Hunk session daemon.", [
      "Unset HUNK_MCP_DISABLE and retry, or omit `--web` to use the terminal review.",
    ]);
  }

  const runtime = createReviewSessionRuntime(input.bootstrap, { rawInput: input.rawInput });
  if (web) {
    try {
      input.controllingTerminal?.close();
    } catch (error) {
      return rethrowAfterReviewCleanup(error, { runtime });
    }
    let hostClient: HunkSessionBrokerClient;
    try {
      hostClient = createReviewHostClient(input, runtime);
    } catch (error) {
      return rethrowAfterReviewCleanup(error, { runtime });
    }
    await runWebReview(runtime, hostClient, input.bootstrap.input.options);
    return;
  }

  let prepared: ReturnType<typeof prepareTerminalReviewBroker> | undefined;
  try {
    prepared = prepareTerminalReviewBroker(input, runtime);
    prepared.hostClient?.start();
  } catch (error) {
    return rethrowAfterReviewCleanup(error, {
      hostClient: prepared?.hostClient,
      controllingTerminal: input.controllingTerminal,
      runtime,
    });
  }
  const { hostClient, sessionNotice } = prepared;

  // This is the only renderer import in orchestration, so browser-only startup never imports or
  // extracts OpenTUI and never mounts against a piped stdin stream.
  try {
    const { runInteractiveApp } = await import("../ui/runInteractiveApp");
    await runInteractiveApp({ ...input, runtime, hostClient, sessionNotice });
  } catch (error) {
    await rethrowAfterReviewCleanup(error, {
      hostClient,
      controllingTerminal: input.controllingTerminal,
      runtime,
    });
  }
}
