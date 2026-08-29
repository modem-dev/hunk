import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build the TypeScript workspace adapter, then execute its conformance suite in real Node. */
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "hunk-session-broker-node-"));
  const outfile = join(directory, "adapter.mjs");
  try {
    const build = await Bun.build({
      entrypoints: [join(process.cwd(), "packages/session-broker-node/src/index.ts")],
      outdir: directory,
      naming: "adapter.mjs",
      target: "node",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!build.success) {
      for (const log of build.logs) console.error(log);
      process.exitCode = 1;
      return;
    }
    const child = Bun.spawn({
      cmd: ["node", "--test", "test/session-broker-node/adapter.test.mjs"],
      cwd: process.cwd(),
      env: { ...process.env, HUNK_NODE_ADAPTER_BUNDLE: outfile },
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
