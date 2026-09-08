import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One Linux pipe buffer. Output used to stop here because `process.exit` dropped whatever stdout
// had not yet handed to the consumer, and Bun reports no backpressure to wait on.
const PIPE_BUFFER_BYTES = 65_536;

/** Build a non-patch document large enough to outgrow several pipe buffers. */
function createGitLogDocument(lineCount: number) {
  return `${Array.from(
    { length: lineCount },
    (_, index) => `commit ${String(index).padStart(8, "0")} some subject line for padding`,
  ).join("\n")}\n`;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("pager output through a pipe", () => {
  test("delivers the whole document to a piped consumer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-pager-pipe-"));
    const document = createGitLogDocument(6_000);
    expect(document.length).toBeGreaterThan(PIPE_BUFFER_BYTES * 3);

    const proc = Bun.spawn(["bun", "run", "packages/hunk/src/main.tsx", "--", "pager"], {
      cwd: process.cwd(),
      stdin: new TextEncoder().encode(document),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // A captured pager host such as LazyGit reads Hunk's stdout from a pipe.
        TERM: "dumb",
        GIT_PAGER: "hunk pager",
        LAZYGIT_LOG_LEVEL: "info",
        HUNK_MCP_DISABLE: "1",
        HUNK_DISABLE_UPDATE_NOTICE: "1",
        XDG_CONFIG_HOME: dir,
      },
    });

    try {
      const [output, exitCode] = await Promise.all([readAll(proc.stdout), proc.exited]);

      expect(exitCode).toBe(0);
      expect(output.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
      expect(output).toBe(document);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
