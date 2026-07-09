import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCli } from "./cli";
import { resolveCliVersion } from "./version";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Run `fn` with Bun.stdin.stream replaced by a one-shot reader of `text`. */
async function withStdin<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const originalStdin = Bun.stdin.stream;
  Bun.stdin.stream = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

  try {
    return await fn();
  } finally {
    Bun.stdin.stream = originalStdin;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseCli", () => {
  test("prints help when no subcommand is passed", async () => {
    const parsed = await parseCli(["bun", "hunk"]);

    expect(parsed.kind).toBe("help");
    if (parsed.kind !== "help") {
      throw new Error("Expected top-level help output.");
    }

    expect(parsed.text).toContain("Usage:");
    expect(parsed.text).toContain("hunk diff");
    expect(parsed.text).toContain("hunk show");
    expect(parsed.text).toContain("hunk skill path");
    expect(parsed.text).toContain("Global options:");
    expect(parsed.text).toContain("Common review options:");
    expect(parsed.text).toContain("auto-reload when the current diff input changes");
    expect(parsed.text).toContain("ignore any agent-context sidecar");
    expect(parsed.text).toContain("Git diff options:");
    expect(parsed.text).toContain("Notes:");
    expect(parsed.text).toContain(
      "Run `hunk <command> --help` for command-specific syntax and options.",
    );
    expect(parsed.text).not.toContain("Config:");
    expect(parsed.text).not.toContain("Examples:");
  });

  test("prints the same top-level help for --help", async () => {
    const bare = await parseCli(["bun", "hunk"]);
    const explicit = await parseCli(["bun", "hunk", "--help"]);

    expect(explicit).toEqual(bare);
  });

  test("resolves the package version metadata", () => {
    expect(resolveCliVersion()).toBe(require("../../package.json").version);
  });

  test("prints the package version for --version and version", async () => {
    const expectedVersion = require("../../package.json").version;
    const flag = await parseCli(["bun", "hunk", "--version"]);
    const command = await parseCli(["bun", "hunk", "version"]);

    expect(flag).toEqual({ kind: "help", text: `${expectedVersion}\n` });
    expect(command).toEqual(flag);
  });

  test("parses git-style diff mode with shared options", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "diff",
      "main...feature",
      "--mode",
      "split",
      "--theme",
      "github-light-default",
      "--agent-context",
      "notes.json",
      "--no-line-numbers",
      "--wrap",
      "--no-hunk-headers",
      "--agent-notes",
      "--transparent-bg",
      "--watch",
    ]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      range: "main...feature",
      staged: false,
      options: {
        mode: "split",
        theme: "github-light-default",
        agentContext: "notes.json",
        watch: true,
        lineNumbers: false,
        wrapLines: true,
        hunkHeaders: false,
        agentNotes: true,
        transparentBackground: true,
      },
    });
  });

  test("parses transparent background toggles", async () => {
    const transparent = await parseCli(["bun", "hunk", "diff", "--transparent-bg"]);
    const opaque = await parseCli(["bun", "hunk", "diff", "--no-transparent-bg"]);

    expect(transparent).toMatchObject({
      kind: "vcs",
      options: {
        transparentBackground: true,
      },
    });
    expect(opaque).toMatchObject({
      kind: "vcs",
      options: {
        transparentBackground: false,
      },
    });
  });

  test("parses agent-context opt-out without leaking commander's boolean sentinel", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff", "--no-agent-context"]);

    expect(parsed.kind).toBe("vcs");
    if (parsed.kind !== "vcs") {
      throw new Error("Expected vcs diff input.");
    }

    expect(parsed.options.noAgentContext).toBe(true);
    expect(parsed.options.agentContext).toBeUndefined();
  });

  test("leaves agent-context opt-out unset without the flag", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff"]);

    expect(parsed.kind).toBe("vcs");
    if (parsed.kind !== "vcs") {
      throw new Error("Expected vcs diff input.");
    }

    expect(parsed.options.noAgentContext).toBeUndefined();
  });

  test("parses staged git-style diff aliases", async () => {
    const staged = await parseCli(["bun", "hunk", "diff", "--staged"]);
    const cached = await parseCli(["bun", "hunk", "diff", "--cached"]);

    expect(staged).toMatchObject({ kind: "vcs", staged: true });
    expect(cached).toMatchObject({ kind: "vcs", staged: true });
  });

  test("parses untracked file toggles for git diff", async () => {
    const excluded = await parseCli(["bun", "hunk", "diff", "--exclude-untracked"]);
    const included = await parseCli(["bun", "hunk", "diff", "--no-exclude-untracked"]);

    expect(excluded).toMatchObject({
      kind: "vcs",
      staged: false,
      options: {
        excludeUntracked: true,
      },
    });
    expect(included).toMatchObject({
      kind: "vcs",
      staged: false,
      options: {
        excludeUntracked: false,
      },
    });
  });

  test("keeps two concrete file paths as file-pair diff mode", async () => {
    const dir = createTempDir("hunk-cli-files-");
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");

    const parsed = await parseCli(["bun", "hunk", "diff", left, right, "--mode", "stack"]);

    expect(parsed).toMatchObject({
      kind: "diff",
      left,
      right,
      options: {
        mode: "stack",
      },
    });
  });

  test("parses pathspec-limited git diffs", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "diff",
      "main",
      "--",
      "src/app.ts",
      "test/app.test.ts",
    ]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      range: "main",
      pathspecs: ["src/app.ts", "test/app.test.ts"],
    });
  });

  test("parses target followed by pathspecs without a separator", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff", "trunk()..@", ".github"]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      range: "trunk()..@",
      pathspecs: [".github"],
    });
  });

  test("parses show mode with optional ref and pathspecs", async () => {
    const parsed = await parseCli(["bun", "hunk", "show", "HEAD~1", "--", "src/app.ts"]);

    expect(parsed).toMatchObject({
      kind: "show",
      ref: "HEAD~1",
      pathspecs: ["src/app.ts"],
    });
  });

  test("parses general pager mode", async () => {
    const parsed = await parseCli(["bun", "hunk", "pager", "--theme", "github-light-default"]);

    expect(parsed).toMatchObject({
      kind: "pager",
      options: {
        theme: "github-light-default",
      },
    });
  });

  test("prints the bundled skill path for hunk skill path", async () => {
    const parsed = await parseCli(["bun", "hunk", "skill", "path"]);

    expect(parsed.kind).toBe("help");
    if (parsed.kind !== "help") {
      throw new Error("Expected bundled skill path output.");
    }

    expect(parsed.text).toEndWith(`${join("skills", "hunk-review", "SKILL.md")}\n`);
  });

  test("prints skill help for hunk skill --help", async () => {
    const parsed = await parseCli(["bun", "hunk", "skill", "--help"]);

    expect(parsed).toEqual({
      kind: "help",
      text: [
        "Usage: hunk skill path",
        "",
        "Print the bundled Hunk review skill path.",
        "Load or symlink that file in your coding agent to keep it in sync across Hunk upgrades.",
        "",
      ].join("\n"),
    });
  });

  test("parses the daemon serve command", async () => {
    const parsed = await parseCli(["bun", "hunk", "daemon", "serve"]);

    expect(parsed).toEqual({
      kind: "daemon-serve",
    });
  });

  test("parses the legacy MCP daemon alias", async () => {
    const parsed = await parseCli(["bun", "hunk", "mcp", "serve"]);

    expect(parsed).toEqual({
      kind: "daemon-serve",
    });
  });

  test("parses session list mode", async () => {
    const parsed = await parseCli(["bun", "hunk", "session", "list", "--json"]);

    expect(parsed).toEqual({
      kind: "session",
      action: "list",
      output: "json",
    });
  });

  test("parses session get by repo alias", async () => {
    const parsed = await parseCli(["bun", "hunk", "session", "get", "--repo", "."]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "get",
      selector: {
        repoRoot: process.cwd(),
      },
      output: "text",
    });
  });

  test("resolves --repo from a subdirectory to the containing repo root", async () => {
    const repoRoot = realpathSync.native(createTempDir("hunk-cli-repo-"));
    mkdirSync(join(repoRoot, ".git"));
    const subdir = join(repoRoot, "packages", "app");
    mkdirSync(subdir, { recursive: true });

    const parsed = await parseCli(["bun", "hunk", "session", "get", "--repo", subdir]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "get",
      selector: { repoRoot },
    });
  });

  test("resolves --repo through a symlinked path to the canonical repo root", async () => {
    const repoRoot = realpathSync.native(createTempDir("hunk-cli-symlink-"));
    mkdirSync(join(repoRoot, ".git"));
    const linkParent = realpathSync.native(createTempDir("hunk-cli-symlink-link-"));
    const link = join(linkParent, "repo-link");
    try {
      symlinkSync(repoRoot, link, "dir");
    } catch {
      // Skip where symlink creation is unsupported (e.g. Windows without privilege).
      return;
    }

    const parsed = await parseCli(["bun", "hunk", "session", "get", "--repo", link]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "get",
      selector: { repoRoot },
    });
  });

  test("parses session review by repo alias", async () => {
    const parsed = await parseCli(["bun", "hunk", "session", "review", "--repo", ".", "--json"]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "review",
      selector: {
        repoRoot: process.cwd(),
      },
      output: "json",
      includePatch: false,
    });
  });

  test("parses session review with raw patch export enabled", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "review",
      "--repo",
      ".",
      "--include-patch",
      "--json",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "review",
      selector: {
        repoRoot: process.cwd(),
      },
      output: "json",
      includePatch: true,
    });
  });

  test("parses session review with live notes included", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "review",
      "session-1",
      "--include-notes",
      "--json",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "review",
      selector: { sessionId: "session-1" },
      output: "json",
      includePatch: false,
      includeNotes: true,
    });
  });

  test("parses session navigate by hunk number", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "session-1",
      "--file",
      "README.md",
      "--hunk",
      "2",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "navigate",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      hunkNumber: 2,
      output: "json",
    });
  });

  test("parses session reload with nested show syntax", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "reload",
      "session-1",
      "--json",
      "--",
      "show",
      "HEAD~1",
      "--",
      "README.md",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "reload",
      selector: { sessionId: "session-1" },
      nextInput: {
        kind: "show",
        ref: "HEAD~1",
        pathspecs: ["README.md"],
      },
      output: "json",
    });
  });

  test("parses split session reload with a separate session path and source directory", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "reload",
      "--session-path",
      "/tmp/live-window",
      "--source",
      "/tmp/source-repo",
      "--json",
      "--",
      "diff",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "reload",
      selector: { sessionPath: resolve("/tmp/live-window") },
      sourcePath: resolve("/tmp/source-repo"),
      nextInput: {
        kind: "vcs",
        staged: false,
        options: {},
      },
      output: "json",
    });
  });

  test("resolves session reload --repo from a subdirectory to the containing repo root", async () => {
    const repoRoot = realpathSync.native(createTempDir("hunk-cli-reload-"));
    mkdirSync(join(repoRoot, ".git"));
    const subdir = join(repoRoot, "packages", "app");
    mkdirSync(subdir, { recursive: true });

    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "reload",
      "--repo",
      subdir,
      "--",
      "diff",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "reload",
      selector: { repoRoot },
    });
  });

  test("rejects session reload without a nested command separator", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "show", "HEAD~1"]),
    ).rejects.toThrow("Pass the replacement Hunk command after `--`");
  });

  test("parses session comment add without focusing by default", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "add",
      "session-1",
      "--file",
      "README.md",
      "--new-line",
      "103",
      "--summary",
      "Frame this as MCP-first",
      "--rationale",
      "Live review is the main value.",
      "--author",
      "Pi",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-add",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      side: "new",
      line: 103,
      summary: "Frame this as MCP-first",
      rationale: "Live review is the main value.",
      author: "Pi",
      reveal: false,
      output: "text",
    });
  });

  test("parses session comment add with --focus", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "add",
      "session-1",
      "--file",
      "README.md",
      "--new-line",
      "103",
      "--summary",
      "Frame this as MCP-first",
      "--focus",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-add",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      side: "new",
      line: 103,
      summary: "Frame this as MCP-first",
      reveal: true,
      output: "text",
    });
  });

  test("parses session comment apply with --focus", async () => {
    const originalStdin = Bun.stdin.stream;
    Bun.stdin.stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"comments":[{"filePath":"README.md","hunk":2,"summary":"Explain this hunk"}]}',
            ),
          );
          controller.close();
        },
      });

    try {
      const parsed = await parseCli([
        "bun",
        "hunk",
        "session",
        "comment",
        "apply",
        "session-1",
        "--stdin",
        "--focus",
        "--json",
      ]);

      expect(parsed).toEqual({
        kind: "session",
        action: "comment-apply",
        selector: { sessionId: "session-1" },
        comments: [
          {
            filePath: "README.md",
            hunkNumber: 2,
            summary: "Explain this hunk",
          },
        ],
        revealMode: "first",
        output: "json",
      });
    } finally {
      Bun.stdin.stream = originalStdin;
    }
  });

  test("rejects session comment apply with an empty comments array", async () => {
    const originalStdin = Bun.stdin.stream;
    Bun.stdin.stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"comments":[]}'));
          controller.close();
        },
      });

    try {
      await expect(
        parseCli(["bun", "hunk", "session", "comment", "apply", "session-1", "--stdin"]),
      ).rejects.toThrow("Session comment apply expected at least one comment.");
    } finally {
      Bun.stdin.stream = originalStdin;
    }
  });

  test("rejects session comment apply when both hunk aliases are present", async () => {
    const originalStdin = Bun.stdin.stream;
    Bun.stdin.stream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"comments":[{"filePath":"README.md","hunk":2,"hunkNumber":2,"summary":"Explain this hunk"}]}',
            ),
          );
          controller.close();
        },
      });

    try {
      await expect(
        parseCli(["bun", "hunk", "session", "comment", "apply", "session-1", "--stdin"]),
      ).rejects.toThrow("Comment 1 must not specify both `hunk` and `hunkNumber`.");
    } finally {
      Bun.stdin.stream = originalStdin;
    }
  });

  test("parses session comment list with file filter", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "list",
      "session-1",
      "--file",
      "README.md",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-list",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      output: "json",
    });
  });

  test("rejects the removed session note namespace", async () => {
    await expect(parseCli(["bun", "hunk", "session", "note", "list", "session-1"])).rejects.toThrow(
      "Unknown session command: note",
    );
  });

  test("parses session comment list with review-note type filter", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "list",
      "session-1",
      "--type",
      "user",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-list",
      selector: { sessionId: "session-1" },
      type: "user",
      output: "text",
    });
  });

  test("rejects session comment list with an unsupported type", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "comment", "list", "session-1", "--type", "robot"]),
    ).rejects.toThrow("Comment type must be one of live, all, ai, agent, or user.");
  });

  test("parses session comment rm", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "rm",
      "session-1",
      "comment-1",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-rm",
      selector: { sessionId: "session-1" },
      commentId: "comment-1",
      output: "text",
    });
  });

  test("parses session comment rm with a repo selector", async () => {
    const repo = createTempDir("hunk-cli-rm-repo-");
    mkdirSync(join(repo, ".git"));
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "rm",
      "--repo",
      repo,
      "user:1",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-rm",
      selector: { repoRoot: realpathSync.native(repo) },
      commentId: "user:1",
      output: "text",
    });
  });

  test("parses session comment clear", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "clear",
      "session-1",
      "--file",
      "README.md",
      "--yes",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-clear",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      confirmed: true,
      output: "text",
    });
  });

  test("parses session comment clear with user notes included", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "comment",
      "clear",
      "session-1",
      "--all",
      "--yes",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "comment-clear",
      selector: { sessionId: "session-1" },
      includeUser: true,
      confirmed: true,
      output: "text",
    });
  });

  test("rejects session commands without an explicit target", async () => {
    await expect(parseCli(["bun", "hunk", "session", "get"])).rejects.toThrow(
      "Specify one live Hunk session with <session-id> or --repo <path>.",
    );
  });

  test("parses session navigate with --next-comment", async () => {
    const repoRoot = realpathSync.native(createTempDir("hunk-cli-navigate-repo-"));
    mkdirSync(join(repoRoot, ".git"));

    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "--repo",
      repoRoot,
      "--next-comment",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "navigate",
      selector: { repoRoot },
      commentDirection: "next",
      output: "text",
    });
  });

  test("parses session navigate with --prev-comment", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "session-1",
      "--prev-comment",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "navigate",
      selector: { sessionId: "session-1" },
      commentDirection: "prev",
      output: "json",
    });
  });

  test("rejects session navigate with both --next-comment and --prev-comment", async () => {
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "navigate",
        "session-1",
        "--next-comment",
        "--prev-comment",
      ]),
    ).rejects.toThrow("Specify either --next-comment or --prev-comment, not both.");
  });

  test("rejects session navigate without --file when not using comment direction", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "navigate", "session-1", "--hunk", "1"]),
    ).rejects.toThrow("Specify --file");
  });

  test("rejects session navigation with multiple target selectors", async () => {
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "navigate",
        "session-1",
        "--file",
        "README.md",
        "--hunk",
        "1",
        "--new-line",
        "103",
      ]),
    ).rejects.toThrow("Specify exactly one navigation target");
  });

  test("rejects session comment clear without confirmation", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "comment", "clear", "session-1"]),
    ).rejects.toThrow("Pass --yes to clear comments.");
  });

  test("parses stash show mode", async () => {
    const parsed = await parseCli(["bun", "hunk", "stash", "show", "stash@{1}"]);

    expect(parsed).toMatchObject({
      kind: "stash-show",
      ref: "stash@{1}",
    });
  });

  test("rejects removed legacy git alias", async () => {
    await expect(parseCli(["bun", "hunk", "git"])).rejects.toThrow("Unknown command: git");
  });

  test("parses patch mode from a file", async () => {
    const parsed = await parseCli(["bun", "hunk", "patch", "changes.patch", "--pager"]);

    expect(parsed).toMatchObject({
      kind: "patch",
      file: "changes.patch",
      options: {
        pager: true,
      },
    });
    if (parsed.kind !== "patch") {
      throw new Error("Expected patch command input.");
    }

    expect(parsed.options.mode).toBeUndefined();
  });

  test("parses difftool mode with display path", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "difftool",
      "left.ts",
      "right.ts",
      "src/example.ts",
      "--mode",
      "stack",
    ]);

    expect(parsed).toMatchObject({
      kind: "difftool",
      left: "left.ts",
      right: "right.ts",
      path: "src/example.ts",
      options: {
        mode: "stack",
      },
    });
    if (parsed.kind !== "difftool") {
      throw new Error("Expected difftool command input.");
    }

    expect(parsed.options.pager).toBeUndefined();
  });
});

describe("parseCli command help text", () => {
  /** Parse `tokens` and assert it resolved to help output, returning the text. */
  async function expectHelp(tokens: string[]) {
    const parsed = await parseCli(["bun", "hunk", ...tokens]);
    expect(parsed.kind).toBe("help");
    if (parsed.kind !== "help") {
      throw new Error(`Expected help output for: ${tokens.join(" ")}`);
    }
    return parsed.text;
  }

  test("renders per-command help for the primary review commands", async () => {
    expect(await expectHelp(["diff", "--help"])).toContain("review diffs or compare two concrete");
    expect(await expectHelp(["show", "-h"])).toContain("review the last commit or a given ref");
    expect(await expectHelp(["patch", "--help"])).toContain("review a patch file");
    expect(await expectHelp(["pager", "--help"])).toContain("general Git pager wrapper");
    expect(await expectHelp(["difftool", "--help"])).toContain("review Git difftool file pairs");
  });

  test("renders the stash command overview and the stash show command help", async () => {
    const overview = await expectHelp(["stash"]);
    expect(overview).toContain("Usage: hunk stash show [ref] [options]");
    expect(overview).toContain("hunk stash show stash@{1}");
    expect(overview).toBe(await expectHelp(["stash", "--help"]));

    expect(await expectHelp(["stash", "show", "--help"])).toContain(
      "review a stash entry as a full Hunk changeset",
    );
  });

  test("renders the daemon overview and the daemon serve command help", async () => {
    const overview = await expectHelp(["daemon"]);
    expect(overview).toContain("Usage: hunk daemon serve");
    expect(overview).toContain("HUNK_MCP_PORT");
    expect(overview).toBe(await expectHelp(["daemon", "--help"]));

    expect(await expectHelp(["daemon", "serve", "--help"])).toContain(
      "Run the local Hunk session daemon and websocket session broker.",
    );
  });

  test("renders the session overview for a bare session command and --help", async () => {
    const overview = await expectHelp(["session"]);
    expect(overview).toContain("Usage: hunk session <subcommand> [options]");
    expect(overview).toContain("hunk session comment add");
    expect(overview).toBe(await expectHelp(["session", "--help"]));
  });

  test("renders help for each session subcommand", async () => {
    expect(await expectHelp(["session", "list", "--help"])).toContain("list live Hunk sessions");
    expect(await expectHelp(["session", "get", "--help"])).toContain("show one live Hunk session");
    expect(await expectHelp(["session", "navigate", "--help"])).toContain(
      "move a live Hunk session to one diff hunk",
    );

    const reloadHelp = await expectHelp(["session", "reload", "--help"]);
    expect(reloadHelp).toContain("replace the contents of one live Hunk session");
    expect(reloadHelp).toContain("hunk session reload --repo . -- diff");
  });

  test("renders skill help for both `skill --help` and `skill path --help`", async () => {
    const bare = await expectHelp(["skill", "--help"]);
    expect(bare).toContain("Usage: hunk skill path");
    expect(await expectHelp(["skill", "path", "--help"])).toBe(bare);
  });

  test("renders the comment overview and per-comment-subcommand help", async () => {
    const overview = await expectHelp(["session", "comment"]);
    expect(overview).toContain("hunk session comment add");
    expect(overview).toBe(await expectHelp(["session", "comment", "--help"]));

    expect(await expectHelp(["session", "comment", "add", "--help"])).toContain(
      "attach one live inline review note",
    );

    const applyHelp = await expectHelp(["session", "comment", "apply", "--help"]);
    expect(applyHelp).toContain("apply many live inline review notes from stdin JSON");
    expect(applyHelp).toContain("Stdin JSON shape:");

    expect(await expectHelp(["session", "comment", "list", "--help"])).toContain(
      "list live inline review notes",
    );
    expect(await expectHelp(["session", "comment", "rm", "--help"])).toContain(
      "remove one inline review note",
    );
    expect(await expectHelp(["session", "comment", "clear", "--help"])).toContain(
      "clear inline review notes",
    );
  });
});

describe("parseCli argument validation", () => {
  test("rejects an invalid layout mode and rethrows the parser error", async () => {
    await expect(parseCli(["bun", "hunk", "diff", "--mode", "bogus"])).rejects.toThrow(
      "Invalid layout mode: bogus",
    );
  });

  test("rethrows commander errors for unknown options", async () => {
    await expect(parseCli(["bun", "hunk", "diff", "--not-a-real-flag"])).rejects.toThrow(
      /unknown option/,
    );
  });

  test("rejects a non-positive integer navigation target", async () => {
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "navigate",
        "session-1",
        "--file",
        "README.md",
        "--hunk",
        "0",
      ]),
    ).rejects.toThrow("Invalid positive integer: 0");
  });

  test("rejects ambiguous diff input that is neither a single target nor a file pair", async () => {
    await expect(parseCli(["bun", "hunk", "diff", "--staged", "left", "right"])).rejects.toThrow(
      "Use `hunk diff [target]",
    );
  });

  test("rejects specifying both a session id and --repo for an explicit selector", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "get", "session-1", "--repo", "."]),
    ).rejects.toThrow("Specify either <session-id> or --repo <path>, not both.");
  });

  test("rejects unknown top-level, skill, daemon, stash, and comment subcommands", async () => {
    await expect(parseCli(["bun", "hunk", "skill", "bogus"])).rejects.toThrow(
      "Only `hunk skill path` is supported.",
    );
    await expect(parseCli(["bun", "hunk", "skill", "path", "extra"])).rejects.toThrow(
      "`hunk skill path` does not accept additional arguments.",
    );
    await expect(parseCli(["bun", "hunk", "daemon", "bogus"])).rejects.toThrow(
      "Only `hunk daemon serve` is supported.",
    );
    await expect(parseCli(["bun", "hunk", "stash", "bogus"])).rejects.toThrow(
      "Only `hunk stash show` is supported.",
    );
    await expect(
      parseCli(["bun", "hunk", "session", "comment", "bogus", "session-1"]),
    ).rejects.toThrow("Supported comment subcommands are add, apply, list, rm, and clear.");
  });

  test("rejects a comment-add target that is not exactly one of --old-line or --new-line", async () => {
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "comment",
        "add",
        "session-1",
        "--file",
        "README.md",
        "--summary",
        "note",
      ]),
    ).rejects.toThrow("Specify exactly one comment target: --old-line <n> or --new-line <n>.");
  });

  test("rejects comment apply without --stdin before reading any input", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "comment", "apply", "session-1"]),
    ).rejects.toThrow("Pass --stdin to read batch comments from stdin JSON.");
  });

  test("rejects comment rm with the wrong target count for each selector style", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "comment", "rm", "session-1"]),
    ).rejects.toThrow(
      "Specify a session id and comment id, or pass --repo <path> with one comment id.",
    );

    const repo = createTempDir("hunk-cli-rm-count-");
    mkdirSync(join(repo, ".git"));
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "comment",
        "rm",
        "--repo",
        repo,
        "comment-1",
        "comment-2",
      ]),
    ).rejects.toThrow("Specify exactly one comment id with --repo <path>.");
  });
});

describe("parseCli session reload validation", () => {
  test("rejects a reload with the `--` separator but no nested command", async () => {
    await expect(parseCli(["bun", "hunk", "session", "reload", "session-1", "--"])).rejects.toThrow(
      "Pass the replacement Hunk command after `--`",
    );
  });

  test("rejects a reload that has no session target at all", async () => {
    await expect(parseCli(["bun", "hunk", "session", "reload", "--", "diff"])).rejects.toThrow(
      "Specify one live Hunk session with <session-id> or --repo <path>",
    );
  });

  test("rejects conflicting reload selectors", async () => {
    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "reload",
        "--session-path",
        "/tmp/live",
        "--repo",
        "/tmp/repo",
        "--",
        "diff",
      ]),
    ).rejects.toThrow(
      "Specify either --session-path <path> or --repo <path> as the target, not both.",
    );

    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "reload",
        "session-1",
        "--session-path",
        "/tmp/live",
        "--",
        "diff",
      ]),
    ).rejects.toThrow("Specify either <session-id> or --session-path <path>, not both.");

    await expect(
      parseCli([
        "bun",
        "hunk",
        "session",
        "reload",
        "session-1",
        "--repo",
        "/tmp/repo",
        "--",
        "diff",
      ]),
    ).rejects.toThrow("Specify either <session-id> or --repo <path>, not both.");
  });

  test("rejects reloading into commands that cannot back a live session", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "--", "pager"]),
    ).rejects.toThrow("Session reload requires a Hunk review command after --");

    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "--", "session", "list"]),
    ).rejects.toThrow("Session reload cannot invoke another session command.");

    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "--", "patch"]),
    ).rejects.toThrow("Session reload does not support `patch -` or stdin-backed patch input.");
  });
});

describe("parseCli session comment apply payload", () => {
  /** Parse a `comment apply` invocation reading `payload` from stdin. */
  function applyWithPayload(payload: string) {
    return withStdin(payload, () =>
      parseCli(["bun", "hunk", "session", "comment", "apply", "session-1", "--stdin"]),
    );
  }

  test("parses a hunk-targeted batch with rationale and author into apply input", async () => {
    const parsed = await applyWithPayload(
      JSON.stringify({
        comments: [
          { filePath: "a.ts", oldLine: 4, summary: "old side", rationale: "why", author: "Pi" },
          { filePath: "b.ts", newLine: 9, summary: "new side" },
        ],
      }),
    );

    expect(parsed).toMatchObject({
      kind: "session",
      action: "comment-apply",
      comments: [
        {
          filePath: "a.ts",
          side: "old",
          line: 4,
          summary: "old side",
          rationale: "why",
          author: "Pi",
        },
        { filePath: "b.ts", side: "new", line: 9, summary: "new side" },
      ],
      revealMode: "none",
    });
  });

  test("rejects an empty stdin payload", async () => {
    await expect(applyWithPayload("   ")).rejects.toThrow(
      "Session comment apply expected one JSON object on stdin.",
    );
  });

  test("rejects invalid JSON", async () => {
    await expect(applyWithPayload("{not json")).rejects.toThrow(
      "Session comment apply expected valid JSON on stdin.",
    );
  });

  test("rejects a non-object top-level value", async () => {
    await expect(applyWithPayload("123")).rejects.toThrow(
      "Session comment apply expected one JSON object with a comments array.",
    );
  });

  test("rejects a payload without a comments array", async () => {
    await expect(applyWithPayload(JSON.stringify({ notes: [] }))).rejects.toThrow(
      "Session comment apply expected a top-level `comments` array.",
    );
  });

  test("rejects a non-object comment entry", async () => {
    await expect(applyWithPayload(JSON.stringify({ comments: [42] }))).rejects.toThrow(
      "Comment 1 must be a JSON object.",
    );
  });

  test("rejects a comment missing filePath", async () => {
    await expect(
      applyWithPayload(JSON.stringify({ comments: [{ summary: "x" }] })),
    ).rejects.toThrow("Comment 1 requires a non-empty `filePath`.");
  });

  test("rejects a comment missing summary", async () => {
    await expect(
      applyWithPayload(JSON.stringify({ comments: [{ filePath: "a.ts" }] })),
    ).rejects.toThrow("Comment 1 requires a non-empty `summary`.");
  });

  test("rejects a non-positive-integer hunk selector", async () => {
    await expect(
      applyWithPayload(JSON.stringify({ comments: [{ filePath: "a.ts", summary: "x", hunk: 0 }] })),
    ).rejects.toThrow("Comment 1 field `hunk` must be a positive integer.");
  });

  test("rejects a comment with no line or hunk selector", async () => {
    await expect(
      applyWithPayload(JSON.stringify({ comments: [{ filePath: "a.ts", summary: "x" }] })),
    ).rejects.toThrow(
      "Comment 1 must specify exactly one of `hunk`, `hunkNumber`, `oldLine`, or `newLine`.",
    );
  });
});
