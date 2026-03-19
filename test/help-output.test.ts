import { describe, expect, test } from "bun:test";

describe("CLI help output", () => {
  test("bare hunk prints standard help without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("hunk diff");
    expect(stdout).toContain("hunk show");
    expect(stdout).toContain("hunk pager");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("general pager mode falls back to plain text for non-diff stdin", () => {
    const proc = Bun.spawnSync(["bash", "-lc", "printf '* main\\n  feature/demo\\n' | HUNK_TEXT_PAGER=cat bun run src/main.tsx pager"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("* main");
    expect(stdout).toContain("feature/demo");
    expect(stdout).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(stdout).not.toContain("\u001b[?1049h");
  });
});
