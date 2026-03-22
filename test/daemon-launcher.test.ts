import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { isLoopbackPortReachable, resolveDaemonLaunchCommand } from "../src/mcp/daemonLauncher";

describe("MCP daemon launcher", () => {
  test("reuses the current script entrypoint when Hunk is running from source or a JS wrapper", () => {
    expect(resolveDaemonLaunchCommand(["bun", "src/main.tsx", "diff"], "/usr/bin/bun")).toEqual({
      command: "/usr/bin/bun",
      args: ["src/main.tsx", "mcp", "serve"],
    });

    expect(
      resolveDaemonLaunchCommand(["node", "/app/bin/hunk.cjs", "diff"], "/usr/bin/node"),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/app/bin/hunk.cjs", "mcp", "serve"],
    });
  });

  test("falls back to relaunching the current executable when no script entrypoint is present", () => {
    expect(
      resolveDaemonLaunchCommand(["/usr/local/bin/hunk", "diff"], "/usr/local/bin/hunk"),
    ).toEqual({
      command: "/usr/local/bin/hunk",
      args: ["mcp", "serve"],
    });
  });

  test("detects whether some process is already listening on the daemon port", async () => {
    const listener = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });

    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(isLoopbackPortReachable({ host: "127.0.0.1", port })).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }

    await expect(isLoopbackPortReachable({ host: "127.0.0.1", port })).resolves.toBe(false);
  });
});
