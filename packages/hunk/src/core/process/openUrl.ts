/**
 * Opens one URL in the user's default browser, keeping its fragment.
 *
 * A review URL carries its capability in the fragment (`#capability=…`), so an opener that drops
 * the fragment opens a page that cannot authenticate. Per platform:
 *
 * - **macOS:** `open <url>`. LaunchServices hands the whole URL to the default browser.
 * - **Linux and other Unix:** the first command in `$BROWSER` when set — the convention Python's
 *   `webbrowser`, xdg-utils, and `git web--browse` share: a `:`-separated list whose entries
 *   receive the URL in place of `%s`, or as a trailing argument — otherwise `xdg-open <url>`.
 *   Both receive the URL as one argument, fragment intact.
 * - **Windows:** PowerShell `Start-Process`, which calls `ShellExecuteEx` with the URL unchanged,
 *   so the registered browser receives the fragment. `rundll32 url.dll,FileProtocolHandler` and
 *   some `explorer.exe` builds are known to strip it, and `cmd /c start` would parse the URL
 *   through cmd's own quoting rules. The URL never enters the PowerShell command text: the
 *   script is a constant that reads it from the `HUNK_OPEN_URL` environment variable.
 * - **WSL:** the same Windows PowerShell through interop, with `HUNK_OPEN_URL` forwarded via
 *   `WSLENV`, so the Windows default browser opens. A WSL install without interop falls back to
 *   the Linux opener.
 *
 * Every command is spawned with an argument vector, never a shell string. The URL is a secret:
 * it is never logged, and a failure is described by the launcher's name and exit status only.
 * The spawn is injectable so tests never start a real browser.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** One launch the opener decided on: the program, its arguments, and extra environment. */
export interface BrowserLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Spawn one launch and report how it ended; injected by tests. */
export type BrowserSpawn = (launch: BrowserLaunch) => Promise<{ ok: boolean; detail?: string }>;

export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether this Linux kernel is WSL; detected from `/proc/version` when absent. */
  isWsl?: boolean;
  spawn?: BrowserSpawn;
}

export type OpenUrlResult = { ok: true } | { ok: false; reason: string };

/** The constant PowerShell script; the URL arrives through the environment, never the text. */
const WINDOWS_START_SCRIPT = "Start-Process -FilePath $env:HUNK_OPEN_URL";

/** Report whether this Linux kernel is the Windows Subsystem for Linux. */
function detectWsl(env: NodeJS.ProcessEnv) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** The PowerShell launch Windows and WSL share, with the URL in the environment. */
function windowsLaunch(url: string, env: NodeJS.ProcessEnv, viaWsl: boolean): BrowserLaunch {
  const extra: Record<string, string> = { HUNK_OPEN_URL: url };
  if (viaWsl) {
    // WSL forwards only the variables WSLENV names to Windows processes.
    extra.WSLENV = env.WSLENV ? `${env.WSLENV}:HUNK_OPEN_URL` : "HUNK_OPEN_URL";
  }
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_START_SCRIPT],
    env: extra,
  };
}

/**
 * Turn the first `$BROWSER` entry into an argument vector.
 *
 * Split on whitespace, with `%s` replaced by the URL (`%%` is a literal `%`) or the URL appended
 * when no `%s` appears. No shell parses it, so a URL cannot be interpreted as syntax.
 */
function browserEnvLaunch(browser: string, url: string): BrowserLaunch | undefined {
  const entry = browser
    .split(":")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!entry) return undefined;
  const words = entry.split(/\s+/);
  let substituted = false;
  const expanded = words.map((word) =>
    word.includes("%s")
      ? ((substituted = true), word.replaceAll("%s", url).replaceAll("%%", "%"))
      : word.replaceAll("%%", "%"),
  );
  const [command, ...args] = expanded;
  return command ? { command, args: substituted ? args : [...args, url] } : undefined;
}

/** Decide how to open one URL on this platform, without starting anything. */
export function planBrowserLaunch(
  url: string,
  options: Omit<OpenUrlOptions, "spawn"> = {},
): BrowserLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return windowsLaunch(url, env, false);
  if (platform === "linux" && (options.isWsl ?? detectWsl(env)) && !env.BROWSER) {
    return windowsLaunch(url, env, true);
  }
  return (
    (env.BROWSER ? browserEnvLaunch(env.BROWSER, url) : undefined) ?? {
      command: "xdg-open",
      args: [url],
    }
  );
}

/** How long a launcher may run before it is treated as having handed off successfully. */
const LAUNCH_SETTLE_MS = 5_000;

/** Spawn one launch detached, judging it by its exit status or its first few seconds. */
const spawnBrowser: BrowserSpawn = (launch) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; detail?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(launch.command, launch.args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...launch.env },
        windowsHide: true,
      });
    } catch (error) {
      settle({ ok: false, detail: (error as NodeJS.ErrnoException).code ?? "spawn failed" });
      return;
    }
    child.once("error", (error: NodeJS.ErrnoException) =>
      settle({ ok: false, detail: error.code ?? "spawn failed" }),
    );
    child.once("exit", (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, detail: `exit status ${code}` }),
    );
    const timer = setTimeout(() => {
      // A browser started in the foreground keeps running; that is a successful hand-off.
      child.unref();
      settle({ ok: true });
    }, LAUNCH_SETTLE_MS);
    timer.unref?.();
  });

/**
 * Open one URL in the default browser.
 *
 * Never throws and never echoes the URL: a failure names the launcher and how it failed.
 */
export async function openUrlInBrowser(
  url: string,
  options: OpenUrlOptions = {},
): Promise<OpenUrlResult> {
  const launch = planBrowserLaunch(url, options);
  const result = await (options.spawn ?? spawnBrowser)(launch).catch(() => ({
    ok: false,
    detail: "spawn failed",
  }));
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        reason: `Could not open a browser with ${launch.command}${result.detail ? ` (${result.detail})` : ""}.`,
      };
}
