import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("non-interactive stdin contracts", () => {
  test("prints a static review and exits when stdout is not a terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-stdin-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    writeFileSync(before, "export const value = 1;\n");
    writeFileSync(after, "export const value = 2;\n");

    const proc = Bun.spawn(
      ["bun", "run", "packages/hunk/src/main.tsx", "--", "diff", "--files", before, after],
      {
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
      },
    );

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("after.ts modified +1 -1");
      expect(stdout).toContain("export const value = 1;");
      expect(stdout).toContain("export const value = 2;");
      expect(stdout).not.toContain("\x1b");
      expect(stdout).not.toContain("View  Navigate  Agent  Help");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
