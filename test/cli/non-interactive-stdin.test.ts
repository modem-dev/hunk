import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MINIMUM_RENDERED_BYTES = 1_000;

async function readUntilRendered(
  stream: ReadableStream<Uint8Array>,
  minimumBytes: number,
  timeoutMs: number,
) {
  const reader = stream.getReader();
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;

  try {
    while (bytes < minimumBytes && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const),
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      bytes += next.value.length;
    }
  } finally {
    reader.releaseLock();
  }

  return bytes;
}

describe("non-interactive stdin contracts", () => {
  test("renders the review and stays alive when stdin is not a terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-stdin-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    writeFileSync(before, "export const value = 1;\n");
    writeFileSync(after, "export const value = 2;\n");

    const proc = Bun.spawn(["bun", "run", "src/main.tsx", "--", "diff", "--files", before, after], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        HUNK_MCP_DISABLE: "1",
        HUNK_DISABLE_UPDATE_NOTICE: "1",
        XDG_CONFIG_HOME: dir,
      },
    });

    try {
      const bytes = await readUntilRendered(proc.stdout, MINIMUM_RENDERED_BYTES, 15_000);
      expect(bytes).toBeGreaterThanOrEqual(MINIMUM_RENDERED_BYTES);
      await expect(
        Promise.race([
          proc.exited.then((code) => ({ exited: true, code })),
          Bun.sleep(250).then(() => ({ exited: false })),
        ]),
      ).resolves.toEqual({ exited: false });
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
