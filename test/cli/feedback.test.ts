import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestConfigHomes, createTestConfigHome } from "../helpers/config-home";

afterAll(cleanupTestConfigHomes);

/**
 * Runs `hunk feedback` as a black box.
 *
 * Every case stops before the send: stdin is never a terminal here and `--skip-confirm` is never
 * passed, so these runs cannot reach Modem even once the build carries a real channel token.
 */
function runFeedback(args: string[], options: { stdin?: string; configToml?: string } = {}) {
  const configHome = createTestConfigHome("hunk-feedback-config-");
  if (options.configToml) {
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(join(configHome, "hunk", "config.toml"), options.configToml);
  }

  const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "feedback", ...args], {
    cwd: process.cwd(),
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

describe("hunk feedback CLI contract", () => {
  test("--dry-run prints the disclosure and the exact body, then exits 0", () => {
    const result = runFeedback(["--dry-run", "--json", "Resize", "loses", "my", "place"]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      sent: boolean;
      reason: string;
      payload: Record<string, unknown>;
    };
    expect(output.sent).toBe(false);
    expect(output.reason).toBe("dry-run");
    expect(output.payload).toMatchObject({
      message: "Resize loses my place",
      source: "tui",
      tags: { category: "user_feedback", os: process.platform, surface: "cli" },
    });
  });

  test("--dry-run text output names the destination and what else is sent", () => {
    const result = runFeedback(["--dry-run", "hello"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ingest.modem.dev");
    expect(result.stdout).toContain("IP address");
    expect(result.stdout).toContain("Dry run: nothing was sent.");
  });

  test("--dry-run without a message exits 2 instead of opening the form", () => {
    const result = runFeedback(["--dry-run"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--dry-run needs a message");
  });

  test("refuses to send without a terminal to confirm on", () => {
    const result = runFeedback(["--file", "-"], { stdin: "y\nPiped message\n" });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("hunk feedback needs confirmation");
    expect(result.stdout).not.toContain("Sent.");
  });

  test("refuses with no message and no terminal", () => {
    const result = runFeedback([]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("needs a message without a terminal");
  });

  test("[feedback] enabled = false turns the command off", () => {
    const result = runFeedback(["--dry-run", "hello"], {
      configToml: "[feedback]\nenabled = false\n",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Feedback is disabled by configuration");
    expect(result.stdout).toBe("");
  });

  test("rejects a message given two ways", () => {
    const result = runFeedback(["hi", "--message", "there"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pass the feedback message one way");
  });
});
