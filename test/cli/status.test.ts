import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareStartupPlan } from "../../packages/hunk/src/app/startup";

const dirs: string[] = [];
const main = resolve(import.meta.dir, "../../packages/hunk/src/main.tsx");
/** Run the source CLI without a terminal or shell. */
function runTestCommand(cwd: string, argv: string[]) {
  const result = Bun.spawnSync(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, "config-home") },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
/** Create a clean Git workspace without inheriting developer status configuration. */
function createTestRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-status-cli-"));
  dirs.push(cwd);
  for (const args of [
    ["init", "-qb", "main"],
    ["config", "user.name", "Status Test"],
    ["config", "user.email", "status@example.com"],
  ]) {
    expect(runTestCommand(cwd, ["git", ...args]).code).toBe(0);
  }
  writeFileSync(join(cwd, "file.txt"), "one\n");
  expect(runTestCommand(cwd, ["git", "add", "."]).code).toBe(0);
  expect(runTestCommand(cwd, ["git", "commit", "-qm", "initial"]).code).toBe(0);
  return cwd;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hunk status CLI contract", () => {
  test("redirects one JSON/static snapshot without touching index or fetching", () => {
    const cwd = createTestRepo();
    writeFileSync(join(cwd, "file.txt"), "two\n");
    const index = statSync(join(cwd, ".git", "index"));
    expect(
      runTestCommand(cwd, [
        "git",
        "config",
        "remote.origin.url",
        "https://example.invalid/never-contact",
      ]).code,
    ).toBe(0);
    const json = runTestCommand(cwd, [
      process.execPath,
      "run",
      main,
      "status",
      "--json",
      "--no-extensions",
      "--color",
      "always",
    ]);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      changedPathCount: 1,
      paths: [{ path: "file.txt", index: "unchanged", worktree: "modified" }],
      siblings: { state: "ready" },
    });
    expect(json.stdout).not.toContain("\x1b");
    expect(statSync(join(cwd, ".git", "index")).mtimeMs).toBe(index.mtimeMs);
    const text = runTestCommand(cwd, [process.execPath, "run", main, "status", "--no-extensions"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("1 changed path");
    expect(text.stdout).toContain("Other worktrees");
    expect(text.stdout).not.toContain("\x1b");
    expect(
      runTestCommand(cwd, [process.execPath, "run", main, "diff", "--no-extensions"]).code,
    ).toBe(0);
    expect(
      runTestCommand(cwd, [process.execPath, "run", main, "show", "--no-extensions"]).code,
    ).toBe(0);
    expect(
      runTestCommand(cwd, [process.execPath, "run", main, "log", "--static", "--no-extensions"])
        .code,
    ).toBe(0);
  });
  test("reports outside, bare and unsupported provider errors with nonzero exits", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hunk-status-errors-"));
    dirs.push(cwd);
    const outside = runTestCommand(cwd, [
      process.execPath,
      "run",
      main,
      "status",
      "--json",
      "--no-extensions",
    ]);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("not a git repository");
    expect(outside.stdout).toBe("");
    expect(runTestCommand(cwd, ["git", "init", "--bare", "-q"]).code).toBe(0);
    const bare = runTestCommand(cwd, [process.execPath, "run", main, "status", "--no-extensions"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("bare");
    const unsupported = runTestCommand(cwd, [
      process.execPath,
      "run",
      main,
      "status",
      "--vcs",
      "jj",
      "--no-extensions",
    ]);
    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain("does not support workspace status");
    const help = runTestCommand(cwd, [process.execPath, "run", main, "status", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--json");
    expect(help.stdout).toContain("--static");
  });
  test("chooses a typed interactive plan only for terminal ownership and honors shared config", async () => {
    const cwd = createTestRepo();
    const configHome = join(cwd, "config-home");
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      join(configHome, "hunk", "config.toml"),
      'theme = "nord"\nline_numbers = false\n',
    );
    for (const [flags, stdinIsTTY, stdoutIsTTY, expected] of [
      [[], true, true, "status-interactive"],
      [["--static"], true, true, "status-static"],
      [["--json"], true, true, "status-static"],
      [[], false, true, "status-static"],
      [[], true, false, "status-static"],
    ] as const) {
      const plan = await prepareStartupPlan(
        [process.execPath, main, "status", "--no-extensions", ...flags],
        {
          cwd,
          env: { ...process.env, XDG_CONFIG_HOME: configHome },
          stdinIsTTY,
          stdoutIsTTY,
        },
      );
      expect(plan.kind).toBe(expected);
      if (plan.kind !== "status-static" && plan.kind !== "status-interactive")
        throw new Error("Unexpected startup route");
      try {
        expect(plan.bootstrap.initialization.theme.initialTheme).toBe("nord");
        expect(plan.bootstrap.initialization.viewPreferences.showLineNumbers).toBe(false);
        expect(plan.bootstrap.snapshot.siblings.state).toBe("loading");
      } finally {
        await plan.bootstrap.close();
        await plan.bootstrap.extensionSession.shutdown();
      }
    }
  });
  test("loads the static entry without renderer dependencies", async () => {
    const result = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../../packages/hunk/src/ui/status/runStaticStatus.ts"),
      ],
      target: "bun",
      external: ["@opentui/*", "react", "@pierre/diffs"],
    });
    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
    expect(output).not.toMatch(/from ["'](?:@opentui|react|@pierre\/diffs)/);
  });
});
