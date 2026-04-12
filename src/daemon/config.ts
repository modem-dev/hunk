import { isIP } from "node:net";

const DEFAULT_HUNK_MCP_HOST = "127.0.0.1";
const DEFAULT_HUNK_MCP_PORT = 47657;
export const HUNK_LEGACY_MCP_PATH = "/mcp";
export const HUNK_SESSION_SOCKET_PATH = "/session";
export const HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV = "HUNK_MCP_UNSAFE_ALLOW_REMOTE";

export interface ResolvedHunkSessionDaemonConfig {
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

/** Return whether the user explicitly opted into exposing the daemon beyond loopback. */
export function allowsUnsafeRemoteSessionDaemon(env: NodeJS.ProcessEnv = process.env) {
  return env[HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV] === "1";
}

/** Resolve the loopback host/port Hunk should use for the local session daemon. */
export function resolveHunkSessionDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHunkSessionDaemonConfig {
  const host = env.HUNK_MCP_HOST?.trim() || DEFAULT_HUNK_MCP_HOST;
  const parsedPort = Number.parseInt(env.HUNK_MCP_PORT ?? "", 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_HUNK_MCP_PORT;

  if (!isLoopbackHost(host) && !allowsUnsafeRemoteSessionDaemon(env)) {
    throw new Error(
      `Hunk session daemon refuses to bind ${host}:${port} because the daemon is local-only by default. ` +
        `Use a loopback host such as 127.0.0.1, localhost, or ::1, or set ${HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV}=1 if you intentionally want remote access.`,
    );
  }

  return {
    host,
    port,
    httpOrigin: `http://${host}:${port}`,
    wsOrigin: `ws://${host}:${port}`,
  };
}
