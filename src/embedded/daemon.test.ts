import { describe, expect, test } from "bun:test";
import { createEmbeddedSessionBrokerAvailability } from "./daemon";
import type { EnsureSessionBrokerAvailableOptions } from "../session-broker/brokerLauncher";

const testConfig = {
  host: "127.0.0.1",
  port: 47657,
  httpOrigin: "http://127.0.0.1:47657",
  wsOrigin: "ws://127.0.0.1:47657",
};

describe("embedded session broker daemon launcher", () => {
  test("passes Hunk package-bin launch options through the broker availability adapter", async () => {
    let captured: EnsureSessionBrokerAvailableOptions | undefined;
    const ensureBroker = createEmbeddedSessionBrokerAvailability({
      cwd: "/repo",
      env: { HUNK_MCP_PORT: "48658" },
      hunkCliPath: "/deps/hunkdiff/bin/hunk.cjs",
      timeoutMs: 1234,
      ensureAvailable: async (options) => {
        captured = options;
      },
    });

    await ensureBroker(testConfig);

    expect(captured).toEqual({
      argv: ["/deps/hunkdiff/bin/hunk.cjs"],
      config: testConfig,
      cwd: "/repo",
      env: { HUNK_MCP_PORT: "48658" },
      execPath: "/deps/hunkdiff/bin/hunk.cjs",
      timeoutMs: 1234,
    });
  });
});
