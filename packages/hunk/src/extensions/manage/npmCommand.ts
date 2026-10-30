import { existsSync } from "node:fs";
import { win32 } from "node:path";

interface WindowsNpmResolution {
  exists: (path: string) => boolean;
  probeNodeExecutable: (node: string, env: NodeJS.ProcessEnv) => string | undefined;
}

/** Ask a Node shim which executable it actually launches, without interpreting shell arguments. */
function probeNodeExecutable(node: string, env: NodeJS.ProcessEnv) {
  try {
    const proc = Bun.spawnSync([node, "--print", "process.execPath"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    return proc.exitCode === 0 ? proc.stdout?.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve native npm shims or Node's npm CLI without executing npm.cmd through cmd.exe. */
export function resolveWindowsNpmCommand(
  npm: string,
  node: string | null,
  env: NodeJS.ProcessEnv,
  io: WindowsNpmResolution = { exists: existsSync, probeNodeExecutable },
): string[] {
  // Native shims such as Volta's npm.exe preserve argument boundaries themselves.
  if (/\.exe$/i.test(npm)) return [npm];
  if (!node) throw new Error("Node.js was not found on PATH");

  const candidates = [npm, node];
  for (const executable of candidates) {
    const cli = win32.join(win32.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js");
    if (io.exists(cli)) return [node, cli];
  }

  // Scoop/fnm-style wrappers may put both commands in a shim directory. Node's
  // process.execPath identifies the active installation without parsing wrapper scripts.
  const actualNode = io.probeNodeExecutable(node, env);
  if (actualNode && win32.isAbsolute(actualNode)) {
    const cli = win32.join(win32.dirname(actualNode), "node_modules", "npm", "bin", "npm-cli.js");
    if (io.exists(cli)) return [node, cli];
  }

  throw new Error(
    "Could not locate npm-cli.js in the active Node.js installation; install Node.js with npm on PATH",
  );
}

/** Resolve npm without invoking a shell, including Windows native and Node-manager shims. */
export function resolveNpmCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const PATH = env.PATH ?? env.Path ?? process.env.PATH;
  const npm = Bun.which("npm", { PATH });
  if (!npm) throw new Error("npm was not found on PATH");
  if (process.platform !== "win32") return [npm];

  return resolveWindowsNpmCommand(npm, Bun.which("node", { PATH }), env);
}
