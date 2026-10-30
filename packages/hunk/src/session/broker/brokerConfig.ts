import { isIP } from "node:net";

export const DEFAULT_SESSION_BROKER_HOST = "127.0.0.1";
export const DEFAULT_SESSION_BROKER_PORT = 47657;
export const SESSION_BROKER_HOST_ENV = "HUNK_MCP_HOST";
export const SESSION_BROKER_PORT_ENV = "HUNK_MCP_PORT";
export const LEGACY_MCP_PATH = "/mcp";
export const SESSION_BROKER_SOCKET_PATH = "/session";
export const UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV = "HUNK_MCP_UNSAFE_ALLOW_REMOTE";

export interface ResolvedSessionBrokerConfig {
  host: string;
  port: number;
  httpOrigin: string;
  wsOrigin: string;
}

/** Return whether one bind host stays on the local loopback interface. */
export function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return isLoopbackHost(normalized.slice(1, -1));
  }

  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHost(normalized.slice("::ffff:".length));
  }

  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return false;
}

/** Return whether the user explicitly opted into exposing the broker beyond loopback. */
export function allowsUnsafeRemoteSessionBroker(env: NodeJS.ProcessEnv = process.env) {
  return env[UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV] === "1";
}

/** Resolve the loopback host/port the local session broker should use. */
export function resolveSessionBrokerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSessionBrokerConfig {
  const host = env[SESSION_BROKER_HOST_ENV]?.trim() || DEFAULT_SESSION_BROKER_HOST;
  const parsedPort = Number.parseInt(env[SESSION_BROKER_PORT_ENV] ?? "", 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_SESSION_BROKER_PORT;

  if (!isLoopbackHost(host) && !allowsUnsafeRemoteSessionBroker(env)) {
    throw new Error(
      `Session broker refuses to bind ${host}:${port} because it is local-only by default. ` +
        `Use a loopback host such as 127.0.0.1, localhost, or ::1, or set ${UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV}=1 if you intentionally want remote access.`,
    );
  }

  // URL authorities require brackets around literal IPv6 addresses, unlike socket APIs.
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;

  return {
    host,
    port,
    httpOrigin: `http://${urlHost}:${port}`,
    wsOrigin: `ws://${urlHost}:${port}`,
  };
}
