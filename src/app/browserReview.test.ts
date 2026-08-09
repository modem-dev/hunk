import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  browserOpenCommand,
  buildBrowserReviewUrl,
  createBrowserReviewCapability,
  openBrowserUrl,
} from "./browserReview";

describe("browser review launch primitives", () => {
  test("keeps a cryptographically strong capability in the URL fragment", () => {
    const first = createBrowserReviewCapability();
    const second = createBrowserReviewCapability();
    expect(first.capability).not.toBe(second.capability);
    expect(first.capability.length).toBeGreaterThanOrEqual(43);
    expect(first.hash).toMatch(/^[a-f\d]{64}$/);
    const url = buildBrowserReviewUrl("http://127.0.0.1:47657", "session / one", first.capability);
    expect(url).toContain("/review/session%20%2F%20one/");
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toContain("capability=");
  });

  test("selects shell-free macOS, Linux, and Windows commands", () => {
    const url = "http://127.0.0.1:47657/review/a/#capability=x&unsafe=y";
    expect(browserOpenCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserOpenCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(browserOpenCommand(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  test("uses argument arrays and reports launch and exit errors", async () => {
    const calls: unknown[][] = [];
    const child = new EventEmitter() as ChildProcess;
    const spawnImpl = ((...args: unknown[]) => {
      calls.push(args);
      queueMicrotask(() => child.emit("exit", 7, null));
      return child;
    }) as typeof spawn;
    await expect(
      openBrowserUrl("http://local/review", { platform: "linux", spawnImpl }),
    ).rejects.toThrow("status 7");
    expect(calls[0]).toEqual([
      "xdg-open",
      ["http://local/review"],
      { stdio: "ignore", detached: false, shell: false },
    ]);
  });
});
