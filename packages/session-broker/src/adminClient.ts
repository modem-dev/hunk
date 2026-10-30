import type { CallerGrant } from "@hunk/session-broker-core";
import {
  DEFAULT_SESSION_BROKER_ADMIN_PATHS,
  SESSION_BROKER_ADMIN_SCOPE_VERSION,
  parseSessionBrokerAdminStatusV1,
  parseSessionBrokerAdminStopResultV1,
  type SessionBrokerAdminPaths,
  type SessionBrokerAdminRequest,
  type SessionBrokerAdminStatusV1,
} from "./admin";
import {
  SessionBrokerCallerClient,
  type SessionBrokerClientCredential,
  type SessionBrokerDaemonVerifier,
} from "./clientAuthentication";
import type { SessionBrokerCrypto } from "./crypto";

export interface SessionBrokerAdminClientOptions {
  readonly appId: string;
  readonly origin: string;
  readonly credential: SessionBrokerClientCredential<CallerGrant>;
  readonly daemon: SessionBrokerDaemonVerifier;
  readonly paths?: Partial<SessionBrokerAdminPaths>;
  readonly fetch?: typeof fetch;
  readonly crypto?: SessionBrokerCrypto;
}

/**
 * Calls the daemon's revision-tolerant admin scope with the ordinary caller credential.
 *
 * The hello proposes `SESSION_BROKER_ADMIN_SCOPE_VERSION` in place of the app revision, so the
 * same signed handshake works against any daemon that exposes the scope regardless of which app
 * revision either side was built with. A daemon that predates the scope answers the hello with a
 * refusal, which surfaces as `SessionBrokerClientAuthenticationError`.
 */
export class SessionBrokerAdminClient {
  private readonly caller: SessionBrokerCallerClient;
  private readonly controlPath: string;

  constructor(options: SessionBrokerAdminClientOptions) {
    const paths = { ...DEFAULT_SESSION_BROKER_ADMIN_PATHS, ...options.paths };
    this.controlPath = paths.control;
    this.caller = new SessionBrokerCallerClient({
      appId: options.appId,
      appRevision: SESSION_BROKER_ADMIN_SCOPE_VERSION,
      origin: options.origin,
      credential: options.credential,
      daemon: options.daemon,
      challengePath: paths.challenge,
      proofPath: paths.proof,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.crypto ? { crypto: options.crypto } : {}),
    });
  }

  /** Report the daemon's identity and attached sessions. */
  async status(signal?: AbortSignal): Promise<SessionBrokerAdminStatusV1> {
    return parseSessionBrokerAdminStatusV1(await this.control({ action: "status" }, signal));
  }

  /** Ask the daemon to shut down gracefully; attached producers are closed with a restart reason. */
  async stop(signal?: AbortSignal): Promise<void> {
    parseSessionBrokerAdminStopResultV1(await this.control({ action: "stop" }, signal));
  }

  private async control(request: SessionBrokerAdminRequest, signal?: AbortSignal) {
    const response = await this.caller.request(this.controlPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      const code = (body as { error?: unknown } | null)?.error;
      throw new Error(
        `Session broker admin ${request.action} failed${typeof code === "string" ? `: ${code}` : "."}`,
      );
    }
    return body;
  }
}
