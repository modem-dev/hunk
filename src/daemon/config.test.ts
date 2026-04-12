import { describe, expect, test } from "bun:test";
import {
  HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV,
  allowsUnsafeRemoteSessionDaemon,
  isLoopbackHost,
  resolveHunkSessionDaemonConfig,
} from "./config";

describe("Hunk session daemon config", () => {
  test("accepts loopback hosts without an unsafe override", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  test("refuses non-loopback binds unless the unsafe override is enabled", () => {
    expect(() =>
      resolveHunkSessionDaemonConfig({
        HUNK_MCP_HOST: "0.0.0.0",
        HUNK_MCP_PORT: "49000",
      }),
    ).toThrow("local-only by default");

    expect(
      resolveHunkSessionDaemonConfig({
        HUNK_MCP_HOST: "0.0.0.0",
        HUNK_MCP_PORT: "49000",
        [HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV]: "1",
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      port: 49000,
    });
  });

  test("reports whether unsafe remote session-daemon access was explicitly enabled", () => {
    expect(allowsUnsafeRemoteSessionDaemon({})).toBe(false);
    expect(allowsUnsafeRemoteSessionDaemon({ [HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV]: "0" })).toBe(
      false,
    );
    expect(allowsUnsafeRemoteSessionDaemon({ [HUNK_MCP_UNSAFE_ALLOW_REMOTE_ENV]: "1" })).toBe(true);
  });
});
