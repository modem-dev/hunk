import type { SessionTargetInput } from "@hunk/session-broker-core";

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
  api: string;
  capabilities: string;
  socket: string;
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
}

export interface SessionBrokerSocketMessageEvent {
  data: unknown;
}

/** Minimal browser-like websocket client shape used by the runtime-neutral connection helper. */
export interface SessionBrokerSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: SessionBrokerSocketMessageEvent) => void) | null;
  onclose: ((event: SessionBrokerSocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
}

export interface SessionBrokerConnectionCloseDirective {
  reconnect?: boolean;
  warning?: string;
}
