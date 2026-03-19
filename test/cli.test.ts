import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/core/cli";

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
    expect(parsed.text).toContain("hunk patch -");
  });

  test("prints the same top-level help for --help", async () => {
    const bare = await parseCli(["bun", "hunk"]);
    const explicit = await parseCli(["bun", "hunk", "--help"]);

    expect(explicit).toEqual(bare);
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
    ]);

    expect(parsed).toMatchObject({
      kind: "git",
      range: "main...feature",
      staged: false,
      options: {
        mode: "split",
        theme: "paper",
        agentContext: "notes.json",
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
    const parsed = await parseCli(["bun", "hunk", "diff", "main", "--", "src/app.ts", "test/app.test.ts"]);

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

  test("parses stash show mode", async () => {
    const parsed = await parseCli(["bun", "hunk", "stash", "show", "stash@{1}"]);

    expect(parsed).toMatchObject({
      kind: "stash-show",
      ref: "stash@{1}",
    });
  });

  test("parses legacy git mode with range and staged flag", async () => {
    const parsed = await parseCli(["bun", "hunk", "git", "HEAD~1..HEAD", "--staged", "--theme", "ember"]);

    expect(parsed).toMatchObject({
      kind: "git",
      range: "HEAD~1..HEAD",
      staged: true,
      options: {
        theme: "ember",
      },
    });
    if (parsed.kind !== "git") {
      throw new Error("Expected legacy git command input.");
    }

    expect(parsed.options.mode).toBeUndefined();
    expect(parsed.options.pager).toBeUndefined();
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
    const parsed = await parseCli(["bun", "hunk", "difftool", "left.ts", "right.ts", "src/example.ts", "--mode", "stack"]);

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
