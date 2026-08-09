import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

export interface BrowserReviewCapability {
  capability: string;
  hash: string;
}

/** Create one high-entropy process-local capability and its broker-safe SHA-256 verifier. */
export function createBrowserReviewCapability(): BrowserReviewCapability {
  const capability = randomBytes(32).toString("base64url");
  return {
    capability,
    hash: createHash("sha256").update(capability, "utf8").digest("hex"),
  };
}

/** Build a local review URL without putting the clear capability in the HTTP request target. */
export function buildBrowserReviewUrl(origin: string, sessionId: string, capability: string) {
  const url = new URL(`/review/${encodeURIComponent(sessionId)}/`, origin);
  url.hash = new URLSearchParams({ capability }).toString();
  return url.toString();
}

/** Select a browser-open command without shell interpolation on any supported platform. */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return {
        command: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", url],
      };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** Open the system browser with an argument array and surface launch or exit failures. */
export function openBrowserUrl(
  url: string,
  options: {
    platform?: NodeJS.Platform;
    spawnImpl?: typeof spawn;
  } = {},
): Promise<void> {
  const selected = browserOpenCommand(url, options.platform);
  const child: ChildProcess = (options.spawnImpl ?? spawn)(selected.command, selected.args, {
    stdio: "ignore",
    detached: false,
    shell: false,
  });
  return new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(new Error(`Could not open the browser: ${error.message}`)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Browser opener exited ${signal ? `from signal ${signal}` : `with status ${code ?? "unknown"}`}.`,
          ),
        );
    });
  });
}
