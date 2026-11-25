import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveSessionBrokerRuntimePaths } from "../../packages/hunk/src/session/broker/brokerLauncher";
import { createTestRuntimeDir } from "./runtime-dir";

test("runtime overrides ignore an inherited HUNK_RUNTIME_DIR", async () => {
  const runtime = createTestRuntimeDir();
  try {
    const inherited: NodeJS.ProcessEnv = { ...process.env, HUNK_RUNTIME_DIR: "developer-runtime" };
    const env = { ...inherited, ...runtime.env };
    const paths = resolveSessionBrokerRuntimePaths({ host: "127.0.0.1", port: 47657 }, env);

    expect(env.HUNK_RUNTIME_DIR).toBeUndefined();
    expect(paths.runtimeDir).toBe(join(runtime.path, "hunk-mcp"));
  } finally {
    await runtime.cleanup();
  }
});
