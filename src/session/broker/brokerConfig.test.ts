import { describe, expect, test } from "bun:test";
import { HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import {
  HUNK_SESSION_BROKER_APP_ID,
  HUNK_SESSION_BROKER_APP_REVISION,
  HUNK_SESSION_BROKER_FEATURES,
  HUNK_SESSION_BROKER_REVISION,
} from "./appContract";
import {
  DEFAULT_SESSION_BROKER_HOST,
  DEFAULT_SESSION_BROKER_PORT,
  SESSION_BROKER_HOST_ENV,
  SESSION_BROKER_PORT_ENV,
  UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV,
  allowsUnsafeRemoteSessionBroker,
  isLoopbackHost,
  resolveSessionBrokerConfig,
} from "./brokerConfig";

describe("Hunk session daemon config", () => {
  test("exports one fixed Phase-1 Hunk contract", () => {
    expect(HUNK_SESSION_BROKER_APP_ID).toBe("dev.hunk");
    expect(HUNK_SESSION_BROKER_REVISION).toBe(1);
    expect(HUNK_SESSION_BROKER_APP_REVISION).toBe(HUNK_SESSION_DAEMON_VERSION);
    expect(HUNK_SESSION_BROKER_FEATURES).toEqual([]);
    expect(Object.isFrozen(HUNK_SESSION_BROKER_FEATURES)).toBe(true);
  });

  test("resolves exported host and port metadata as runtime defaults", () => {
    expect(resolveSessionBrokerConfig({})).toMatchObject({
      host: DEFAULT_SESSION_BROKER_HOST,
      port: DEFAULT_SESSION_BROKER_PORT,
    });
    expect(
      resolveSessionBrokerConfig({
        [SESSION_BROKER_HOST_ENV]: "localhost",
        [SESSION_BROKER_PORT_ENV]: "49000",
      }),
    ).toMatchObject({ host: "localhost", port: 49000 });
  });

  test("formats IPv6 literal origins with URL authority brackets", () => {
    expect(
      resolveSessionBrokerConfig({
        [SESSION_BROKER_HOST_ENV]: "::1",
        [SESSION_BROKER_PORT_ENV]: "49000",
      }),
    ).toMatchObject({
      host: "::1",
      port: 49000,
      httpOrigin: "http://[::1]:49000",
      wsOrigin: "ws://[::1]:49000",
    });
  });

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
      resolveSessionBrokerConfig({
        HUNK_MCP_HOST: "0.0.0.0",
        HUNK_MCP_PORT: "49000",
      }),
    ).toThrow("local-only by default");

    expect(
      resolveSessionBrokerConfig({
        HUNK_MCP_HOST: "0.0.0.0",
        HUNK_MCP_PORT: "49000",
        [UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV]: "1",
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      port: 49000,
    });
  });

  test("reports whether unsafe remote session-daemon access was explicitly enabled", () => {
    expect(allowsUnsafeRemoteSessionBroker({})).toBe(false);
    expect(allowsUnsafeRemoteSessionBroker({ [UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV]: "0" })).toBe(
      false,
    );
    expect(allowsUnsafeRemoteSessionBroker({ [UNSAFE_ALLOW_REMOTE_SESSION_BROKER_ENV]: "1" })).toBe(
      true,
    );
  });
});
