import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** Drop the ambient markers that would make Hunk treat this run as a captured pager host. */
function uncapturedPagerEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "LV" && key !== "GIT_PAGER" && !key.startsWith("LAZYGIT"),
    ),
  );
}

describe("CLI entrypoint contracts", () => {
  test("bare hunk prints standard help without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx"], {
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
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "daemon", "--help"], {
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
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "session", "--help"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      "hunk session review (<session-id> | --repo <path>) [--include-patch] [--include-notes]",
    );
    expect(stdout).toContain(
      "hunk session comment apply (<session-id> | --repo <path>) --stdin [--focus]",
    );
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints session reload help without terminal takeover sequences", () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "packages/hunk/src/main.tsx", "session", "reload", "--help"],
      {
        cwd: process.cwd(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: session reload");
    expect(stdout).toContain("hunk session reload --repo . -- diff");
    expect(stdout).not.toContain("\u001b[?1049h");
  });

  test("prints the package version for --version without terminal takeover sequences", () => {
    const expectedVersion = require("../../packages/hunk/package.json").version;
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "--version"], {
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
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "skill", "path"], {
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
    const proc = Bun.spawnSync(["node", "packages/hunk/bin/hunk.cjs", "skill", "path"], {
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
    const packageJson = require("../../packages/hunk/package.json");
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
      copyFileSync(join(process.cwd(), "packages", "hunk", "bin", "hunk.cjs"), tempWrapperPath);

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
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "pager"], {
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

  test("general pager mode keeps Git colors in non-diff stdin for captured pager hosts", () => {
    const coloredLog = "\u001b[33m*\u001b[m \u001b[32mabc1234\u001b[m feat: thing\n";
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "pager"], {
      cwd: process.cwd(),
      stdin: Buffer.from(coloredLog),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...uncapturedPagerEnv(), TERM: "dumb", LAZYGIT_NEW_DIR_FILE: "/tmp/lazygit-dir" },
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
    expect(stdout).toBe(coloredLog);
  });

  test("general pager mode strips colors from non-diff stdin outside captured pager hosts", () => {
    const coloredLog = "\u001b[33m*\u001b[m \u001b[32mabc1234\u001b[m feat: thing\n";
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "pager"], {
      cwd: process.cwd(),
      stdin: Buffer.from(coloredLog),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...uncapturedPagerEnv(), TERM: "dumb" },
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
    expect(stdout).toBe("* abc1234 feat: thing\n");
  });

  test("general pager mode passes diff stdin through when stdout is not a terminal", () => {
    const patchText = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "pager"], {
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
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

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
      expect(stderr).toContain("hunk diff --files <before-file> <after-file>");
      expect(stderr).not.toContain("at runGitText");
      expect(stderr).not.toContain("loadGitChangeset");
      expect(stderr).not.toContain("Bun v");
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });

  test("runs an explicit generic extension CLI command with raw args and stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-cli-"));
    const extensionPath = join(root, "tools.ts");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `export default function (hunk) {
  hunk.registerCliCommand({ name: "tools", summary: "Test tools" }, async (args, ctx) => {
    let input = "";
    for await (const chunk of ctx.stdin) input += new TextDecoder().decode(chunk);
    await ctx.stdout.write(JSON.stringify({ args, input, cwd: ctx.cwd }) + "\\n");
    return { kind: "exit", code: 9 };
  });
}\n`,
      );

      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "tools", "sync", "--help"],
        {
          cwd: root,
          stdin: Buffer.from("payload"),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(9);
      expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
      expect(JSON.parse(Buffer.from(proc.stdout).toString("utf8"))).toEqual({
        args: ["sync", "--help"],
        input: "payload",
        // `ctx.cwd` is the spawned process's own cwd, which macOS reports through the
        // `/var` -> `/private/var` symlink that `tmpdir()` hands back unresolved.
        cwd: realpathSync(root),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs the self-contained GitHub PR extension help through generic CLI discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-github-pr-help-"));
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");
    const extensionPath = join(process.cwd(), "examples/extensions/github-pr");

    try {
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "gh", "--help"],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(0);
      expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
      expect(Buffer.from(proc.stdout).toString("utf8")).toContain("Usage: hunk gh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers the installed-shape GitHub extension for literal hunk gh", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-github-pr-global-"));
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");
    const extensionPath = join(process.cwd(), "examples/extensions/github-pr");
    const installedPath = join(root, "config", "hunk", "extensions", "github-pr");

    try {
      mkdirSync(join(root, "config", "hunk", "extensions"), { recursive: true });
      cpSync(extensionPath, installedPath, { recursive: true });
      const proc = Bun.spawnSync(["bun", "run", sourceEntrypoint, "gh", "--help"], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
      });

      expect(proc.exitCode).toBe(0);
      expect(Buffer.from(proc.stderr).toString("utf8")).toBe("");
      expect(Buffer.from(proc.stdout).toString("utf8")).toContain("Usage: hunk gh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns before repo config steers an extension CLI provider", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-cli-config-"));
    const extensionPath = join(root, "tools.ts");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(root, ".hunk"), { recursive: true });
      writeFileSync(join(root, ".hunk", "config.toml"), '[extension.tools]\ntoken = "repo"\n');
      writeFileSync(
        extensionPath,
        `export default function (hunk) {
  hunk.registerCliCommand({ name: "config-probe", summary: "Probe config" }, async (_args, ctx) => {
    await ctx.stdout.write(String(hunk.config.token) + "\\n");
    return { kind: "exit" };
  });
}\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "config-probe"],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(0);
      expect(Buffer.from(proc.stdout).toString("utf8")).toBe("repo\n");
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain(
        "Repo config overrides settings for extension(s): tools",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows stderr progress before delegating to a built-in command", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-delegate-"));
    const extensionPath = join(root, "delegate.ts");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `export default function (hunk) {
  hunk.registerCliCommand({ name: "handoff", summary: "Delegate" }, async (_args, ctx) => {
    await ctx.stderr.write("preparing\\n");
    return { kind: "delegate", argv: ["--version"] };
  });
}\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "handoff"],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(0);
      expect(Buffer.from(proc.stdout).toString("utf8")).toMatch(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/,
      );
      expect(Buffer.from(proc.stderr).toString("utf8")).toBe("preparing\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels a pending stdin read when an extension command exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-pending-stdin-"));
    const extensionPath = join(root, "stdin.ts");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `export default function (hunk) {
  hunk.registerCliCommand({ name: "pending-stdin", summary: "Read once" }, (_args, ctx) => {
    void ctx.stdin[Symbol.asyncIterator]().next();
    return { kind: "exit" };
  });
}\n`,
      );
      const proc = Bun.spawn(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "pending-stdin"],
        {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(2_000).then(() => "timeout" as const),
      ]);
      if (exitCode === "timeout") proc.kill();

      expect(exitCode).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects delegation when both the extension and built-in need stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-stdin-delegate-"));
    const extensionPath = join(root, "stdin.ts");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `export default function (hunk) {
  hunk.registerCliCommand({ name: "stdin-delegate", summary: "Delegate" }, async (_args, ctx) => {
    for await (const _chunk of ctx.stdin) {}
    return { kind: "delegate", argv: ["diff", "--agent-context", "-"] };
  });
}\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "stdin-delegate"],
        {
          cwd: root,
          stdin: Buffer.from("context"),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(1);
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain(
        "extension read stdin before delegating",
      );
      expect(Buffer.from(proc.stderr).toString("utf8")).not.toContain(
        "ReadableStream has already been used",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses an explicit extension factory across built-in review delegation", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-review-delegate-"));
    const extensionPath = join(root, "delegate.ts");
    const countPath = join(root, "factory-count");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countPath = ${JSON.stringify(countPath)};
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
writeFileSync(countPath, String(count + 1));
export default function (hunk) {
  hunk.registerCliCommand({ name: "review-delegate", summary: "Delegate" }, () => ({
    kind: "delegate",
    argv: ["diff"],
  }));
}\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "review-delegate"],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(1);
      expect(readFileSync(countPath, "utf8")).toBe("1");
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain(
        "must be run inside a Git repository",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects impossible extension command names before importing providers", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-invalid-command-"));
    const extensionPath = join(root, "provider.ts");
    const markerPath = join(root, "imported");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `await Bun.write(${JSON.stringify(markerPath)}, "yes");\nexport default function () {}\n`,
      );
      const proc = Bun.spawnSync(
        ["bun", "run", sourceEntrypoint, "--extension", extensionPath, "--bogus"],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(1);
      expect(existsSync(markerPath)).toBe(false);
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain("Unknown command: --bogus");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not let --extension consume the hard-disable flag or import a later provider", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-missing-path-"));
    const extensionPath = join(root, "provider.ts");
    const markerPath = join(root, "imported");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `await Bun.write(${JSON.stringify(markerPath)}, "yes");\nexport default function () {}\n`,
      );
      const proc = Bun.spawnSync(
        [
          "bun",
          "run",
          sourceEntrypoint,
          "--extension",
          "--no-extensions",
          "--extension",
          extensionPath,
          "provider",
        ],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(1);
      expect(existsSync(markerPath)).toBe(false);
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain(
        "`--extension` requires an extension entry path",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not import an explicit command provider when extensions are disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-extension-disabled-"));
    const extensionPath = join(root, "disabled.ts");
    const markerPath = join(root, "imported");
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

    try {
      writeFileSync(
        extensionPath,
        `await Bun.write(${JSON.stringify(markerPath)}, "yes");
export default function (hunk) {
  hunk.registerCliCommand({ name: "disabled", summary: "Disabled" }, () => ({ kind: "exit" }));
}\n`,
      );
      const proc = Bun.spawnSync(
        [
          "bun",
          "run",
          sourceEntrypoint,
          "--no-extensions",
          "--extension",
          extensionPath,
          "disabled",
        ],
        {
          cwd: root,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") },
        },
      );

      expect(proc.exitCode).toBe(1);
      expect(existsSync(markerPath)).toBe(false);
      expect(Buffer.from(proc.stderr).toString("utf8")).toContain("Unknown command: disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prints a friendly invalid-ref error without a Bun stack trace", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "hunk-show-cli-"));
    const sourceEntrypoint = join(process.cwd(), "packages/hunk/src/main.tsx");

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
