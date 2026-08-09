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
import type {
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

/** Construct the one runtime and broker client shared by every review surface. */
function createReviewAuthority({ bootstrap, rawInput }: ReviewSessionInput) {
  const runtime = createReviewSessionRuntime(bootstrap, { rawInput });
  const runtimeSnapshot = runtime.getSnapshot();
  const registration = createSessionRegistration(bootstrap, runtimeSnapshot.projection.document, {
    browserReviewCapabilityHash: runtime.getBrowserReviewCapabilityHash(),
  });
  const initialSnapshot = createSessionSnapshotFromReviewState(runtimeSnapshot.store.getSnapshot());
  assertSessionRegistrationEnvelopeWithinBounds(registration, initialSnapshot);
  const hostClient = new SessionBrokerClient<
    HunkSessionInfo,
    HunkSessionState,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  >(registration, initialSnapshot);
  runtime.attachHostClient(hostClient);
  return { runtime, hostClient };
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

/** Keep a renderer-free browser-owned review alive until the owning process receives a signal. */
async function runWebReview(
  runtime: ReturnType<typeof createReviewSessionRuntime>,
  hostClient: SessionBrokerClient<
    HunkSessionInfo,
    HunkSessionState,
    HunkSessionServerMessage,
    HunkSessionCommandResult
  >,
  options: CliInput["options"],
) {
  if (process.env.HUNK_MCP_DISABLE === "1") {
    throw new HunkUserError("Browser review requires the local Hunk session daemon.", [
      "Unset HUNK_MCP_DISABLE and retry, or omit `--web` to use the terminal review.",
    ]);
  }
  const config = resolveSessionBrokerConfig();
  if (!isLoopbackHost(config.host) || allowsUnsafeRemoteSessionBroker()) {
    throw new HunkUserError(
      "Browser review is available only through Hunk's safe loopback daemon.",
      ["Use HUNK_MCP_HOST=127.0.0.1 and disable unsafe remote broker access."],
    );
  }

  hostClient.start();
  runtime.start();
  const url = runtime.getBrowserReviewUrl(config.httpOrigin);

  try {
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
  } finally {
    hostClient.stop();
    await runtime.shutdown();
  }
}

/** Select a renderer over one already-loaded review authority without duplicating bootstrap work. */
export async function runReviewSession(input: ReviewSessionInput): Promise<void> {
  const { runtime, hostClient } = createReviewAuthority(input);
  if (input.bootstrap.input.options.web) {
    input.controllingTerminal?.close();
    await runWebReview(runtime, hostClient, input.bootstrap.input.options);
    return;
  }

  hostClient.start();
  // This is the only renderer import in orchestration, so browser-only startup never imports or
  // extracts OpenTUI and never mounts against a piped stdin stream.
  const { runInteractiveApp } = await import("../ui/runInteractiveApp");
  await runInteractiveApp({ ...input, runtime, hostClient });
}
