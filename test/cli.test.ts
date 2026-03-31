import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/core/cli";
import { resolveCliVersion } from "../src/core/version";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
    expect(parsed.text).toContain("Global options:");
    expect(parsed.text).toContain("Common review options:");
    expect(parsed.text).toContain("auto-reload when the current diff input changes");
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
    expect(resolveCliVersion()).toBe(require("../package.json").version);
  });

  test("prints the package version for --version and version", async () => {
    const expectedVersion = require("../package.json").version;
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
      "paper",
      "--agent-context",
      "notes.json",
      "--no-line-numbers",
      "--wrap",
      "--no-hunk-headers",
      "--agent-notes",
      "--watch",
    ]);

    expect(parsed).toMatchObject({
      kind: "git",
      range: "main...feature",
      staged: false,
      options: {
        mode: "split",
        theme: "paper",
        agentContext: "notes.json",
        watch: true,
        lineNumbers: false,
        wrapLines: true,
        hunkHeaders: false,
        agentNotes: true,
      },
    });
  });

  test("parses staged git-style diff aliases", async () => {
    const staged = await parseCli(["bun", "hunk", "diff", "--staged"]);
    const cached = await parseCli(["bun", "hunk", "diff", "--cached"]);

    expect(staged).toMatchObject({ kind: "git", staged: true });
    expect(cached).toMatchObject({ kind: "git", staged: true });
  });

  test("parses untracked file toggles for git diff", async () => {
    const excluded = await parseCli(["bun", "hunk", "diff", "--exclude-untracked"]);
    const included = await parseCli(["bun", "hunk", "diff", "--no-exclude-untracked"]);

    expect(excluded).toMatchObject({
      kind: "git",
      staged: false,
      options: {
        excludeUntracked: true,
      },
    });
    expect(included).toMatchObject({
      kind: "git",
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
      kind: "git",
      range: "main",
      pathspecs: ["src/app.ts", "test/app.test.ts"],
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
    const parsed = await parseCli(["bun", "hunk", "pager", "--theme", "paper"]);

    expect(parsed).toMatchObject({
      kind: "pager",
      options: {
        theme: "paper",
      },
    });
  });

  test("parses the MCP daemon command", async () => {
    const parsed = await parseCli(["bun", "hunk", "mcp", "serve"]);

    expect(parsed).toEqual({
      kind: "mcp-serve",
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
      selector: { sessionPath: "/tmp/live-window" },
      sourcePath: "/tmp/source-repo",
      nextInput: {
        kind: "git",
        staged: false,
        options: {},
      },
      output: "json",
    });
  });

  test("rejects session reload without a nested command separator", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "show", "HEAD~1"]),
    ).rejects.toThrow("Pass the replacement Hunk command after `--`");
  });

  test("parses session comment add", async () => {
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
      "--no-reveal",
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

  test("rejects session commands without an explicit target", async () => {
    await expect(parseCli(["bun", "hunk", "session", "get"])).rejects.toThrow(
      "Specify one live Hunk session with <session-id> or --repo <path>.",
    );
  });

  test("parses session navigate with --next-comment", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "--repo",
      "/tmp/repo",
      "--next-comment",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "navigate",
      selector: { repoRoot: "/tmp/repo" },
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
    ).rejects.toThrow("Pass --yes to clear live comments.");
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
