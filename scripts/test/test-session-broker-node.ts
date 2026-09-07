import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build the TypeScript workspace adapter, then execute its conformance suite in real Node. */
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "hunk-session-broker-node-"));
  const outfile = join(directory, "adapter.mjs");
  const connectionFixture = join(directory, "connection-fixture.mjs");
  try {
    const builds = await Promise.all([
      Bun.build({
        entrypoints: [join(process.cwd(), "packages/session-broker-node/src/index.ts")],
        outdir: directory,
        naming: "adapter.mjs",
        target: "node",
        format: "esm",
        minify: false,
        sourcemap: "none",
      }),
      Bun.build({
        entrypoints: [join(process.cwd(), "test/session-broker-node/connection-fixture.ts")],
        outdir: directory,
        naming: "connection-fixture.mjs",
        target: "node",
        format: "esm",
        minify: false,
        sourcemap: "none",
      }),
    ]);
    if (builds.some((build) => !build.success)) {
      for (const build of builds) {
        for (const log of build.logs) console.error(log);
      }
      process.exitCode = 1;
      return;
    }
    const child = Bun.spawn({
      cmd: ["node", "--test", "test/session-broker-node/adapter.test.mjs"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUNK_NODE_ADAPTER_BUNDLE: outfile,
        HUNK_NODE_CONNECTION_FIXTURE: connectionFixture,
        HUNK_SESSION_BROKER_NODE_PACKAGE_JSON: join(
          process.cwd(),
          "packages/session-broker-node/package.json",
        ),
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

await main();
