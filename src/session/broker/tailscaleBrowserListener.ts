import { spawnSync } from "node:child_process";
import { parseTailscaleIpv4 } from "../tailscale";
import { BrowserReviewServer, withBrowserReviewSecurityHeaders } from "./browserReviewServer";

interface BrowserOnlyServer {
  stop(closeActiveConnections?: boolean): unknown;
}

export interface TailscaleBrowserListenerOptions {
  port: number;
  browserReview: BrowserReviewServer;
  detectIp?: () => string;
  serve?: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }) => BrowserOnlyServer;
}

/** Detect the local tailnet IPv4 address without invoking a command shell. */
export function detectTailscaleIpv4(run: typeof spawnSync = spawnSync) {
  const result = run("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3_000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error("Timed out waiting for `tailscale ip -4` after 3 seconds.");
    }
    throw new Error(
      "Could not run `tailscale ip -4`. Install Tailscale, sign in, and ensure `tailscale` is on PATH.",
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `Tailscale is unavailable or not signed in.${detail ? ` ${detail}` : " Run `tailscale up` and retry."}`,
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const addresses = lines.map(parseTailscaleIpv4);
  if (addresses.length !== 1 || !addresses[0]) {
    throw new Error("Tailscale did not report exactly one valid 100.64.0.0/10 IPv4 address.");
  }
  return addresses[0];
}

/** Own one daemon-wide, browser-only listener on the exact local Tailscale address. */
export class TailscaleBrowserListener {
  private server: BrowserOnlyServer | null = null;
  private origin: string | null = null;
  private enabling: Promise<string> | null = null;

  constructor(private readonly options: TailscaleBrowserListenerOptions) {}

  enable() {
    if (this.origin) return Promise.resolve(this.origin);
    if (this.enabling) return this.enabling;
    this.enabling = Promise.resolve().then(() => {
      const detectedAddress = (this.options.detectIp ?? detectTailscaleIpv4)();
      const address = parseTailscaleIpv4(detectedAddress);
      if (!address) {
        throw new Error("Tailscale listener requires one canonical 100.64.0.0/10 IPv4 address.");
      }
      const origin = `http://${address}:${this.options.port}`;
      const fetch = (request: Request) => this.handleRequest(request, origin);
      try {
        this.server = (this.options.serve ?? ((serverOptions) => Bun.serve(serverOptions)))({
          hostname: address,
          port: this.options.port,
          fetch,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not bind the Tailscale browser listener on ${address}:${this.options.port}. ${detail}`,
        );
      }
      this.origin = origin;
      return origin;
    });
    return this.enabling.finally(() => {
      this.enabling = null;
    });
  }

  /** Stop the optional listener without affecting the loopback broker transport. */
  stop() {
    this.server?.stop(true);
    this.server = null;
    this.origin = null;
  }

  private async handleRequest(request: Request, origin: string) {
    const rawPath = request.url.match(/^[a-z]+:\/\/[^/]*(\/[^?#]*)/i)?.[1] ?? "";
    const isBrowserRoute =
      rawPath === "/review-auth" ||
      rawPath.startsWith("/review/") ||
      rawPath.startsWith("/review-api/");
    const reject = (message: string, status: number) =>
      withBrowserReviewSecurityHeaders(Response.json({ error: message }, { status }));
    if (!isBrowserRoute)
      return reject("Tailscale listener serves browser review routes only.", 404);
    if (request.headers.get("host") !== new URL(origin).host) {
      return reject("Invalid Host header.", 403);
    }
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== origin) {
      return reject("Cross-origin browser review requests are not allowed.", 403);
    }
    return (
      (await this.options.browserReview.handle(request)) ??
      reject("Browser review route not found.", 404)
    );
  }
}
