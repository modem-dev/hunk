import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tempDirs: string[] = [];
const mainPath = resolve(import.meta.dir, "../../src/main.tsx");

/** Run a command and fail the fixture immediately when it cannot complete. */
function run(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const proc = Bun.spawnSync(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

/** Create a two-commit repository with deterministic author and dates. */
function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-test-"));
  tempDirs.push(cwd);
  expect(run(["git", "init", "-q"], cwd).code).toBe(0);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Ada Lovelace",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Lovelace",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  };
  writeFileSync(join(cwd, "history.txt"), "one\n");
  expect(run(["git", "add", "history.txt"], cwd, env).code).toBe(0);
  expect(
    run(["git", "commit", "-q", "-m", "First commit"], cwd, {
      ...env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    }).code,
  ).toBe(0);
  writeFileSync(join(cwd, "history.txt"), "two\n");
  const secondEnv = {
    ...env,
    GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
  };
  expect(
    run(["git", "commit", "-qa", "-m", "Second commit", "-m", "A detailed body."], cwd, secondEnv)
      .code,
  ).toBe(0);
  expect(run(["git", "tag", "v1.0.0"], cwd, secondEnv).code).toBe(0);
  expect(run(["git", "tag", "-a", "v1.0.0-annotated", "-m", "release"], cwd, secondEnv).code).toBe(
    0,
  );
  return cwd;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("hunk log CLI contract", () => {
  test("prints deterministic complete static rows without terminal controls", () => {
    const cwd = createRepo();
    const result = run(["bun", "run", mainPath, "log", "--color", "never"], cwd);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).toContain("First commit");
    expect(result.stdout).toContain("A detailed body.");
    expect(result.stdout).toContain("Author: Ada Lovelace <ada@example.com>");
    expect(result.stdout).toContain("Date:   2026-01-02 00:00:00Z");
    expect(result.stdout).toMatch(/commit [0-9a-f]{40} \(HEAD -> /);
    expect(result.stdout).toContain("tag: v1.0.0");
    expect(result.stdout).toContain("tag: v1.0.0-annotated");
    expect(result.stdout).not.toContain("\x1b");
  });

  test("supports explicit compact output and shared themes", () => {
    const cwd = createRepo();
    const result = run(
      [
        "bun",
        "run",
        mainPath,
        "log",
        "--oneline",
        "--theme",
        "catppuccin-mocha",
        "--color",
        "always",
        "-n",
        "1",
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).not.toContain("Author:");
    expect(result.stdout).toContain("\x1b[38;2;");
  });

  test("honors max count, pathspecs, ASCII, and explicit color", () => {
    const cwd = createRepo();
    const result = run(
      [
        "bun",
        "run",
        mainPath,
        "log",
        "-n",
        "1",
        "--ascii",
        "--color",
        "always",
        "--",
        "history.txt",
      ],
      cwd,
    );

    expect(result.code).toBe(0);
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("*  commit");
    expect(result.stdout).toContain("Second commit");
    expect(result.stdout).not.toContain("First commit");
    expect(result.stdout).toContain("\x1b[");
  });

  test("is silent for max count zero and reports non-repositories cleanly", () => {
    const cwd = createRepo();
    expect(run(["bun", "run", mainPath, "log", "-n", "0"], cwd)).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const outside = mkdtempSync(join(tmpdir(), "hunk-log-outside-"));
    tempDirs.push(outside);
    const failed = run(["bun", "run", mainPath, "log"], outside);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("not a git repository");
    expect(failed.stdout).not.toContain("\x1b");
  });
});
