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

function hostBinaryCandidate() {
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };

  const platform = platformMap[process.platform] || process.platform;
  const arch = archMap[process.arch] || process.arch;
  const binary = platform === "windows" ? "hunk.exe" : "hunk";

  if (platform === "darwin") {
    if (arch === "arm64") return { packageName: "hunkdiff-darwin-arm64", binary };
    if (arch === "x64") return { packageName: "hunkdiff-darwin-x64", binary };
  }

  if (platform === "linux") {
    if (arch === "arm64") return { packageName: "hunkdiff-linux-arm64", binary };
    if (arch === "x64") return { packageName: "hunkdiff-linux-x64", binary };
  }

  if (platform === "windows") {
    if (arch === "x64") return { packageName: "hunkdiff-windows-x64", binary };
  }

  return null;
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o755 });
}

function createWrapperFixture(tempDir: string, prebuiltScript: string, bunScript: string) {
  const candidate = hostBinaryCandidate();
  if (!candidate) {
    throw new Error(`Unsupported host for wrapper fixture: ${process.platform} ${process.arch}`);
  }

  const tempBinDir = join(tempDir, "bin");
  const tempWrapperPath = join(tempBinDir, "hunk.cjs");
  mkdirSync(tempBinDir, { recursive: true });
  copyFileSync(join(process.cwd(), "bin", "hunk.cjs"), tempWrapperPath);

  const prebuiltBinDir = join(tempDir, "node_modules", candidate.packageName, "bin");
  mkdirSync(prebuiltBinDir, { recursive: true });
  writeExecutable(join(prebuiltBinDir, candidate.binary), prebuiltScript);

  const bunBinDir = join(tempDir, "node_modules", "bun", "bin");
  mkdirSync(bunBinDir, { recursive: true });
  writeExecutable(join(bunBinDir, "bun.exe"), bunScript);

  mkdirSync(join(tempDir, "dist", "npm"), { recursive: true });
  writeFileSync(join(tempDir, "dist", "npm", "main.js"), "");

  return tempWrapperPath;
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

  test("package manifest exposes hunkdiff as an npm exec alias", () => {
    const packageJson = require("../../package.json");
    expect(packageJson.bin).toEqual({
      hunk: "./bin/hunk.cjs",
      hunkdiff: "./bin/hunk.cjs",
    });
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

  test("bin wrapper falls back to bundled Bun when the prebuilt binary exits with SIGILL", () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "hunk-wrapper-sigill-"));

    try {
      const tempWrapperPath = createWrapperFixture(
        tempDir,
        "#!/bin/sh\nkill -ILL $$\n",
        "#!/bin/sh\nshift\nprintf 'fallback:%s\\n' \"$*\"\n",
      );

      const proc = Bun.spawnSync(["node", tempWrapperPath, "--version"], {
        cwd: tempDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(0);
      expect(stdout).toBe("fallback:--version\n");
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("bin wrapper preserves normal prebuilt exit status instead of falling back", () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "hunk-wrapper-prebuilt-exit-"));

    try {
      const tempWrapperPath = createWrapperFixture(
        tempDir,
        "#!/bin/sh\nprintf 'native\\n'\nexit 7\n",
        "#!/bin/sh\nprintf 'fallback\\n'\n",
      );

      const proc = Bun.spawnSync(["node", tempWrapperPath, "--version"], {
        cwd: tempDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(7);
      expect(stdout).toBe("native\n");
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("bin wrapper does not fall back when the explicit override binary exits with SIGILL", () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), "hunk-wrapper-override-sigill-"));

    try {
      const tempWrapperPath = createWrapperFixture(
        tempDir,
        "#!/bin/sh\nprintf 'native\\n'\n",
        "#!/bin/sh\nprintf 'fallback\\n'\n",
      );
      const overrideBinary = join(tempDir, "override-hunk");
      writeExecutable(overrideBinary, "#!/bin/sh\nkill -ILL $$\n");

      const proc = Bun.spawnSync(["node", tempWrapperPath, "--version"], {
        cwd: tempDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HUNK_BIN_PATH: overrideBinary },
      });

      const stdout = Buffer.from(proc.stdout).toString("utf8");
      const stderr = Buffer.from(proc.stderr).toString("utf8");

      expect(proc.exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("general pager mode falls back to plain text for non-diff stdin", () => {
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "pager"], {
      cwd: process.cwd(),
      stdin: Buffer.from("* main\n  feature/demo\n"),
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
    expect(stdout).not.toContain("View  Navigate  Agent  Help");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("general pager mode passes diff stdin through when stdout is not a terminal", () => {
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const proc = Bun.spawnSync(["bun", "run", "src/main.tsx", "pager"], {
      cwd: process.cwd(),
      stdin: Buffer.from(patchText),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(patchText);
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
