import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      Buffer.from(proc.stderr).toString("utf8").trim() || `git ${args.join(" ")} failed`,
    );
  }
}

describe("CLI entrypoint contracts", () => {
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
    expect(stdout).toContain("Global options:");
    expect(stdout).toContain("Common review options:");
    expect(stdout).toContain("auto-reload when the current diff input changes");
    expect(stdout).toContain("Git diff options:");
    expect(stdout).toContain("Notes:");
    expect(stdout).toContain(
      "Run `hunk <command> --help` for command-specific syntax and options.",
    );
    expect(stdout).not.toContain("Config:");
    expect(stdout).not.toContain("Examples:");
    expect(stdout).toContain("hunk pager");
    expect(stdout).toContain("hunk session <subcommand>");
    expect(stdout).toContain("hunk skill path");
    expect(stdout).toContain("hunk daemon serve");
    expect(stdout).not.toContain("hunk mcp serve");
    expect(stdout).not.toContain("hunk git");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints daemon help without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "daemon", "--help"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: hunk daemon serve");
    expect(stdout).toContain("HUNK_MCP_PORT");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints session help with the review command without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", "--help"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("hunk session review <session-id> [--include-patch]");
    expect(stdout).toContain("hunk session review --repo <path> [--include-patch]");
    expect(stdout).toContain(
      "hunk session comment apply (<session-id> | --repo <path>) --stdin [--focus]",
    );
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints session reload help without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "session", "reload", "--help"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: session reload");
    expect(stdout).toContain("hunk session reload --repo . -- diff");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints the package version for --version without terminal takeover sequences", () => {
    const expectedVersion = require("../../package.json").version;
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "--version"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(`${expectedVersion}\n`);
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints the bundled skill path for hunk skill path without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "skill", "path"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    const resolvedPath = stdout.trim();

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(resolvedPath).toEndWith(join("skills", "hunk-review", "SKILL.md"));
    expect(existsSync(resolvedPath)).toBe(true);
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("bin wrapper prints the bundled skill path for hunk skill path", () => {
    const proc = Bun.spawnSync(["node", "bin/hunk.cjs", "skill", "path"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    const resolvedPath = stdout.trim();

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(resolvedPath).toEndWith(join("skills", "hunk-review", "SKILL.md"));
    expect(existsSync(resolvedPath)).toBe(true);
  });

  test("bin wrapper fails clearly when the bundled skill is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "hunk-wrapper-skill-missing-"));
    const tempBinDir = join(tempDir, "bin");
    const tempWrapperPath = join(tempBinDir, "hunk.cjs");

    try {
      mkdirSync(tempBinDir, { recursive: true });
      copyFileSync(join(process.cwd(), "bin", "hunk.cjs"), tempWrapperPath);

      const proc = Bun.spawnSync(["node", tempWrapperPath, "skill", "path"], {
        cwd: tempDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("hunk: could not locate the bundled Hunk review skill");
      expect(stderr).toContain(join("skills", "hunk-review", "SKILL.md"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("general pager mode falls back to plain text for non-diff stdin", () => {
    const proc = Bun.spawnSync(
      [
        "bash",
        "-lc",
        "printf '* main\\n  feature/demo\\n' | HUNK_TEXT_PAGER=cat bun run src/main.tsx pager",
      ],
      {
        cwd: process.cwd(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("* main");
    expect(stdout).toContain("feature/demo");
    expect(stdout).not.toContain("View  Navigate  Theme  Agent  Help");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints a friendly git-repo error without a Bun stack trace", () => {
    const nonRepoDir = mkdtempSync(join(tmpdir(), "hunk-nonrepo-"));
    const sourceEntrypoint = join(process.cwd(), "src/main.tsx");

    try {
      const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, "diff"], {
        cwd: nonRepoDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("hunk: `hunk diff` must be run inside a Git repository.");
      expect(stderr).toContain("hunk diff <before-file> <after-file>");
      expect(stderr).not.toContain("at runGitText");
      expect(stderr).not.toContain("loadGitChangeset");
      expect(stderr).not.toContain("Bun v");
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });

  test("prints a friendly invalid-ref error without a Bun stack trace", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "hunk-show-cli-"));
    const sourceEntrypoint = join(process.cwd(), "src/main.tsx");

    try {
      git(repoDir, "init");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "alpha.ts"), "export const alpha = 1;\n");
      git(repoDir, "add", "alpha.ts");
      git(repoDir, "commit", "-m", "initial");

      const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, "show", "HEAD~999"], {
        cwd: repoDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("hunk: `hunk show HEAD~999` could not resolve Git ref `HEAD~999`.");
      expect(stderr).toContain("Check the ref name and try again.");
      expect(stderr).not.toContain("runGitText");
      expect(stderr).not.toContain("Bun v");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
