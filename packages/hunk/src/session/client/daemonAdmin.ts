import {
  SessionBrokerAdminClient,
  SessionBrokerClientAuthenticationError,
  type SessionBrokerAdminStatusV1,
} from "@hunk/session-broker";
import { HUNK_SESSION_BROKER_APP_ID } from "../broker/appContract";
import {
  resolveSessionBrokerConfig,
  type ResolvedSessionBrokerConfig,
} from "../broker/brokerConfig";
import { loadOrCreateHunkSessionBrokerCredentials } from "../broker/credentials";
import { HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS, withSessionDaemonHttpTimeout } from "./daemonHttp";

/**
 * Reads and controls the running daemon through its revision-tolerant admin scope.
 *
 * Both the TUI (to explain a refused hello) and `hunk daemon status` / `restart` converge here.
 * The probe distinguishes a daemon that predates the scope from one that is simply not running,
 * because each needs a different message and a different fallback.
 */
export type HunkDaemonAdminProbe =
  | { kind: "status"; status: SessionBrokerAdminStatusV1 }
  /** The listener answered but refused the admin hello: a daemon from before the scope existed. */
  | { kind: "unsupported" }
  /** Nothing answered at the daemon origin. */
  | { kind: "unavailable" };

/** Create the admin client bound to this process's on-disk caller credential. */
export async function createHunkSessionDaemonAdminClient(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
) {
  const credentials = await loadOrCreateHunkSessionBrokerCredentials();
  return new SessionBrokerAdminClient({
    appId: HUNK_SESSION_BROKER_APP_ID,
    origin: config.httpOrigin,
    credential: credentials.caller,
    daemon: { keyId: credentials.daemonIdentity.keyId, publicKey: credentials.daemonPublicKey },
  });
}

/** Classify one admin call failure without reflecting transport details to the caller. */
function classifyAdminFailure(error: unknown): "unsupported" | "unavailable" {
  return error instanceof SessionBrokerClientAuthenticationError ? "unsupported" : "unavailable";
}

/** Read the daemon's admin status, tolerating both an older daemon and an absent one. */
export async function probeHunkSessionDaemonAdminStatus(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
): Promise<HunkDaemonAdminProbe> {
  try {
    return await withSessionDaemonHttpTimeout({
      operation: "report its status",
      timeoutMs,
      task: async (signal) => {
        const client = await createHunkSessionDaemonAdminClient(config);
        return { kind: "status", status: await client.status(signal) } as const;
      },
    });
  } catch (error) {
    return { kind: classifyAdminFailure(error) };
  }
}

/** Ask the daemon to stop; resolves `unsupported` for a daemon that predates the admin scope. */
export async function requestHunkSessionDaemonStop(
  config: ResolvedSessionBrokerConfig = resolveSessionBrokerConfig(),
  timeoutMs = HUNK_SESSION_DAEMON_HTTP_TIMEOUT_MS,
): Promise<"stopping" | "unsupported" | "unavailable"> {
  try {
    await withSessionDaemonHttpTimeout({
      operation: "acknowledge the stop request",
      timeoutMs,
      task: async (signal) => {
        const client = await createHunkSessionDaemonAdminClient(config);
        await client.stop(signal);
      },
    });
    return "stopping";
  } catch (error) {
    return classifyAdminFailure(error);
  }
}
