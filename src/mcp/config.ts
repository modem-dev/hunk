const DEFAULT_HUNK_MCP_HOST = "127.0.0.1";
const DEFAULT_HUNK_MCP_PORT = 47657;
export const HUNK_MCP_PATH = "/mcp";
export const HUNK_SESSION_SOCKET_PATH = "/session";

export interface ResolvedHunkMcpConfig {
  host: string;
  port: number;
  httpOrigin: string;
  wsOrigin: string;
}

/** Resolve the loopback host/port Hunk should use for the local MCP daemon. */
export function resolveHunkMcpConfig(env: NodeJS.ProcessEnv = process.env): ResolvedHunkMcpConfig {
  const host = env.HUNK_MCP_HOST?.trim() || DEFAULT_HUNK_MCP_HOST;
  const parsedPort = Number.parseInt(env.HUNK_MCP_PORT ?? "", 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_HUNK_MCP_PORT;

  return {
    host,
    port,
    httpOrigin: `http://${host}:${port}`,
    wsOrigin: `ws://${host}:${port}`,
  };
}
