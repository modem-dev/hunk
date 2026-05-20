import { describe, expect, test } from "bun:test";
import { createEmbeddedSessionBrokerAvailability } from "./daemon";
import { resolveSessionBrokerConfig } from "../session-broker/brokerConfig";
import type { EnsureSessionBrokerAvailableOptions } from "../session-broker/brokerLauncher";

const testConfig = resolveSessionBrokerConfig({ HUNK_MCP_PORT: "47657" });

describe("embedded session broker daemon launcher", () => {
  test("passes Hunk package-bin launch options through the broker availability adapter", async () => {
    let captured: EnsureSessionBrokerAvailableOptions | undefined;
    const ensureBroker = createEmbeddedSessionBrokerAvailability({
      cwd: "/repo",
      env: { HUNK_MCP_PORT: "48658" },
      hunkCliPath: "/deps/hunkdiff/bin/hunk.cjs",
      runtimePath: "/usr/local/bin/node",
      timeoutMs: 1234,
      ensureAvailable: async (options) => {
        captured = options;
      },
    });

    await ensureBroker(testConfig);

    expect(captured).toEqual({
      argv: ["/usr/local/bin/node", "/deps/hunkdiff/bin/hunk.cjs"],
      config: testConfig,
      cwd: "/repo",
      env: { HUNK_MCP_PORT: "48658" },
      execPath: "/usr/local/bin/node",
      timeoutMs: 1234,
    });
  });

  test("passes direct Hunk executable paths through without a runtime wrapper", async () => {
    let captured: EnsureSessionBrokerAvailableOptions | undefined;
    const ensureBroker = createEmbeddedSessionBrokerAvailability({
      cwd: "/repo",
      hunkCliPath: "/deps/hunkdiff/bin/hunk",
      runtimePath: "/usr/local/bin/node",
      ensureAvailable: async (options) => {
        captured = options;
      },
    });

    await ensureBroker(testConfig);

    expect(captured).toMatchObject({
      argv: ["/deps/hunkdiff/bin/hunk"],
      execPath: "/deps/hunkdiff/bin/hunk",
    });
  });
});
