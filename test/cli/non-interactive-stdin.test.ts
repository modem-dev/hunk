import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run the source CLI with captured output and an isolated configuration directory. */
async function runCapturedHunk(args: string[], configHome: string) {
  const proc = Bun.spawn(["bun", "run", "packages/hunk/src/main.tsx", "--", ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HUNK_MCP_DISABLE: "1",
      HUNK_DISABLE_UPDATE_NOTICE: "1",
      XDG_CONFIG_HOME: configHome,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("non-interactive stdin contracts", () => {
  test("prints a static review and exits when stdout is not a terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-stdin-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    writeFileSync(before, "export const value = 1;\n");
    writeFileSync(after, "export const value = 2;\n");

    try {
      const { exitCode, stdout, stderr } = await runCapturedHunk(
        ["diff", "--files", before, after],
        dir,
      );

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

  test("does not truncate long lines in redirected split output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-split-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    const shared = "x".repeat(130);
    writeFileSync(before, `export const value = "${shared}OLDTAIL";\n`);
    writeFileSync(after, `export const value = "${shared}NEWTAIL";\n`);

    try {
      const { exitCode, stdout, stderr } = await runCapturedHunk(
        ["diff", "--files", before, after, "--mode", "split"],
        dir,
      );

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("OLDTAIL");
      expect(stdout).toContain("NEWTAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects watch mode instead of silently printing one snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-watch-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    writeFileSync(before, "export const value = 1;\n");
    writeFileSync(after, "export const value = 2;\n");

    try {
      const { exitCode, stdout, stderr } = await runCapturedHunk(
        ["diff", "--files", before, after, "--watch"],
        dir,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("`--watch` requires an interactive output terminal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("prints startup notices to stderr with static output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-non-tty-notice-"));
    const before = join(dir, "before.ts");
    const after = join(dir, "after.ts");
    const configDir = join(dir, "hunk");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), '[themes.dracula]\nbase = "nord"\n');
    writeFileSync(before, "export const value = 1;\n");
    writeFileSync(after, "export const value = 2;\n");

    try {
      const { exitCode, stdout, stderr } = await runCapturedHunk(
        ["diff", "--files", before, after],
        dir,
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("after.ts modified +1 -1");
      expect(stderr).toContain('hunk: warning: Skipped theme "dracula" from config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
