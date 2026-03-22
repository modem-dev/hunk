import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { resolveHunkMcpConfig, type ResolvedHunkMcpConfig } from "./config";

const SCRIPT_ENTRYPOINT_PATTERN = /[\\/]|\.(?:[cm]?js|tsx?)$/;

export interface DaemonLaunchCommand {
  command: string;
  args: string[];
}

/** Resolve how the current Hunk process should launch a sibling `hunk mcp serve` daemon. */
export function resolveDaemonLaunchCommand(
  argv = process.argv,
  execPath = process.execPath,
): DaemonLaunchCommand {
  const entrypoint = argv[1];

  if (entrypoint && !entrypoint.startsWith("-") && SCRIPT_ENTRYPOINT_PATTERN.test(entrypoint)) {
    return {
      command: execPath,
      args: [entrypoint, "mcp", "serve"],
    };
  }

  return {
    command: execPath,
    args: ["mcp", "serve"],
  };
}

/** Check whether the loopback Hunk daemon already answers health probes. */
export async function isHunkDaemonHealthy(
  config: ResolvedHunkMcpConfig = resolveHunkMcpConfig(),
  timeoutMs = 500,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${config.httpOrigin}/health`, {
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check whether some local process is already accepting TCP connections on the daemon port. */
export function isLoopbackPortReachable(
  config: Pick<ResolvedHunkMcpConfig, "host" | "port"> = resolveHunkMcpConfig(),
  timeoutMs = 500,
) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({
      host: config.host,
      port: config.port,
    });

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Wait briefly for a just-launched daemon to become reachable on its health endpoint. */
export async function waitForHunkDaemonHealth({
  config = resolveHunkMcpConfig(),
  timeoutMs = 3_000,
  intervalMs = 100,
}: {
  config?: ResolvedHunkMcpConfig;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHunkDaemonHealthy(config)) {
      return true;
    }

    await Bun.sleep(intervalMs);
  }

  return false;
}

/** Launch the Hunk daemon in the background without tying it to the current TTY session. */
export function launchHunkDaemon({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
}: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
} = {}): ChildProcess {
  const command = resolveDaemonLaunchCommand(argv, execPath);
  const child = spawn(command.command, command.args, {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  return child;
}
