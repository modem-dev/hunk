import { describe, expect, test } from "bun:test";
import type { BrowserReviewServer } from "./browserReviewServer";
import { detectTailscaleIpv4, TailscaleBrowserListener } from "./tailscaleBrowserListener";

/** Build an injected listener without binding a real tailnet interface. */
function createTestListener() {
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | null = null;
  let serves = 0;
  let stops = 0;
  const browserReview = {
    handle: async () => new Response("review"),
  } as unknown as BrowserReviewServer;
  const listener = new TailscaleBrowserListener({
    port: 47657,
    browserReview,
    detectIp: () => "100.70.1.2",
    serve: (options) => {
      serves += 1;
      fetchHandler = options.fetch;
      return { stop: () => (stops += 1) };
    },
  });
  return {
    listener,
    request: (path: string, headers: HeadersInit = {}) =>
      fetchHandler!(new Request(`http://100.70.1.2:47657${path}`, { headers })),
    counts: () => ({ serves, stops }),
  };
}

describe("Tailscale browser-only listener", () => {
  test("reports missing and logged-out Tailscale CLI states", () => {
    expect(() =>
      detectTailscaleIpv4((() => ({
        error: new Error("ENOENT"),
        status: null,
        stdout: "",
        stderr: "",
      })) as never),
    ).toThrow("Install Tailscale");
    expect(() =>
      detectTailscaleIpv4((() => ({ status: 1, stdout: "", stderr: "not logged in" })) as never),
    ).toThrow("not logged in");
    const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(() =>
      detectTailscaleIpv4((() => ({
        error: timedOut,
        status: null,
        stdout: "",
        stderr: "",
      })) as never),
    ).toThrow("after 3 seconds");
  });

  test("enables once, reuses its exact origin, and stops with the daemon", async () => {
    const testListener = createTestListener();
    await expect(
      Promise.all([testListener.listener.enable(), testListener.listener.enable()]),
    ).resolves.toEqual(["http://100.70.1.2:47657", "http://100.70.1.2:47657"]);
    expect(testListener.counts()).toEqual({ serves: 1, stops: 0 });
    testListener.listener.stop();
    expect(testListener.counts()).toEqual({ serves: 1, stops: 1 });
  });

  test("serves only browser paths with exact Host and Origin", async () => {
    const testListener = createTestListener();
    await testListener.listener.enable();
    expect(
      (await testListener.request("/review/session/", { host: "100.70.1.2:47657" })).status,
    ).toBe(200);
    for (const path of ["/health", "/session", "/session-api", "/session-api/capabilities", "/mcp"])
      expect((await testListener.request(path, { host: "100.70.1.2:47657" })).status).toBe(404);
    expect(
      (await testListener.request("/review/session/", { host: "attacker.invalid" })).status,
    ).toBe(403);
    expect(
      (
        await testListener.request("/review-api/session/snapshot", {
          host: "100.70.1.2:47657",
          origin: "http://attacker.invalid",
        })
      ).status,
    ).toBe(403);
  });

  test("reports bind failures without retaining a partial listener", async () => {
    const listener = new TailscaleBrowserListener({
      port: 47657,
      browserReview: { handle: async () => null } as unknown as BrowserReviewServer,
      detectIp: () => "100.70.1.2",
      serve: () => {
        throw new Error("address already in use");
      },
    });
    await expect(listener.enable()).rejects.toThrow(
      "Could not bind the Tailscale browser listener on 100.70.1.2:47657",
    );
    listener.stop();
  });
});
