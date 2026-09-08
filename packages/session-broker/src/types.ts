import type {
  BrokerAppContract,
  CallerOperation,
  CallerPrincipal,
  SessionTargetInput,
} from "@hunk/session-broker-core";
import type { SessionBrokerResponseAuthentication } from "./authentication";

export const DEFAULT_SESSION_BROKER_HEALTH_PATH = "/health";
export const DEFAULT_SESSION_BROKER_API_PATH = "/broker";
export const DEFAULT_SESSION_BROKER_CAPABILITIES_PATH = `${DEFAULT_SESSION_BROKER_API_PATH}/capabilities`;
export const DEFAULT_SESSION_BROKER_SOCKET_PATH = "/session";

/** Describe one runtime-neutral broker capability payload. */
export interface SessionBrokerCapabilities {
  version: number;
  name?: string;
  features?: string[];
  [key: string]: unknown;
}

export interface SessionBrokerHttpPaths {
  health: string;
  socket: string;
  api?: string;
  capabilities?: string;
}

export type SessionBrokerDaemonRequest<
  CommandName extends string = string,
  CommandInput = unknown,
> =
  | {
      action: "list";
    }
  | {
      action: "get";
      selector: SessionTargetInput;
    }
  | {
      action: "dispatch";
      selector: SessionTargetInput;
      command: CommandName;
      commandVersion?: number;
      input: CommandInput;
      timeoutMs?: number;
      timeoutMessage?: string;
    };

export type SessionBrokerDaemonResponse<SessionView = unknown, CommandResult = unknown> =
  | {
      sessions: SessionView[];
    }
  | {
      session: SessionView;
    }
  | {
      result: CommandResult;
    };

/** Carry one structured daemon body together with its generation-bound response signature. */
export interface SessionBrokerAuthenticatedResponse<Body = unknown> {
  readonly body: Body;
  readonly authentication: SessionBrokerResponseAuthentication;
}

/** Select the fixed Phase-1 application contract for target-specific responses. */
export interface SessionBrokerTargetContract extends BrokerAppContract {
  readonly features: readonly [];
}

export interface SessionBrokerHealth {
  ok: boolean;
  pid: number;
  sessions: number;
  pendingCommands: number;
  startedAt: string;
  uptimeMs: number;
  staleSessionTtlMs: number;
  paths: SessionBrokerHttpPaths;
}

export interface SessionBrokerSocketCloseEvent {
  code: number;
  reason: string;
  /** Whether this socket completed authentication and became the active producer transport. */
  authenticated?: boolean;
}

export interface SessionBrokerSocketMessageEvent {
  data: unknown;
}

/** Minimal browser-like websocket client shape used by the runtime-neutral connection helper. */
export interface SessionBrokerSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: SessionBrokerSocketMessageEvent) => void) | null;
  onclose: ((event: SessionBrokerSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
}

export interface SessionBrokerConnectionCloseDirective {
  reconnect?: boolean;
  warning?: string;
}

/** Facts supplied to the mandatory app authorization hook after signed authentication. */
export interface SessionBrokerAuthorizationContext {
  readonly principal: CallerPrincipal;
  readonly operation: CallerOperation;
  readonly sessionId?: string;
  readonly command?: string;
  readonly commandVersion?: number;
  readonly requestId?: string;
  readonly signal: AbortSignal;
}

export type SessionBrokerAuthorizer = (
  context: SessionBrokerAuthorizationContext,
) => boolean | Promise<boolean>;

/** Redacted decision metadata suitable for an app-owned audit sink. */
export interface SessionBrokerAuditEvent {
  readonly appId: string;
  readonly principalId?: string;
  readonly keyId?: string;
  readonly sessionId?: string;
  readonly operation: CallerOperation | "unknown";
  readonly command?: string;
  readonly commandVersion?: number;
  readonly requestId?: string;
  readonly decision: "allow" | "deny";
  readonly outcome: "authenticated" | "authentication-failed" | "authorization-failed";
  readonly timestamp: number;
}

export type SessionBrokerAuditHook = (event: SessionBrokerAuditEvent) => void | Promise<void>;
