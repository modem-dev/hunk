import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLI_REFERENCE_COMMANDS,
  COMMON_REVIEW_OPTIONS,
  createCliReferenceCommand,
  parseCli,
  WATCH_OPTION,
} from "./cli";
import { resolveCliVersion } from "../core/run/version";

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
    expect(parsed.text).toContain("hunk log");
    expect(parsed.text).toContain("attractive repository history");
    expect(parsed.text).not.toContain("Git commit history");
    expect(parsed.text).toContain("hunk skill path");
    expect(parsed.text).toContain("Global options:");
    expect(parsed.text).toContain("Common review options:");
    expect(parsed.text).toContain("--file-gap");
    expect(parsed.text).toContain("file separator rows, including ─");
    expect(parsed.text).toContain("--hunk-gap");
    expect(parsed.text).toContain("blank rows before later hunks");
    expect(parsed.text).toContain("auto-reload when the current diff input changes");
    expect(parsed.text).toContain("--experimental");
    expect(parsed.text).toContain("experimental STML");
    expect(parsed.text).toContain("--fast");
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

  test("registers each command's runtime options from its reference metadata", () => {
    for (const [key, spec] of Object.entries(CLI_REFERENCE_COMMANDS)) {
      const expectedFlags = [
        ...("commonReviewOptions" in spec && spec.commonReviewOptions
          ? COMMON_REVIEW_OPTIONS.map((option) => option.flag)
          : []),
        ...("watch" in spec && spec.watch ? [WATCH_OPTION.flag] : []),
        ...("options" in spec ? spec.options.map((option) => option.flag) : []),
      ];
      const command = createCliReferenceCommand(key as keyof typeof CLI_REFERENCE_COMMANDS);

      expect(command.options.map((option) => option.flags)).toEqual(expectedFlags);
      expect(command.description()).toBe(spec.summary);
    }
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
      "-x4",
      "--wrap",
      "--no-hunk-headers",
      "--agent-notes",
      "--transparent-bg",
      "--watch",
      "--experimental",
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
        experimental: true,
        lineNumbers: false,
        tabWidth: 4,
        wrapLines: true,
        hunkHeaders: false,
        agentNotes: true,
        transparentBackground: true,
      },
    });
  });

  test("parses the current-line style and rejects an unknown one", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff", "--cursor-line", "number"]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      options: { cursorLine: "number" },
    });

    await expect(parseCli(["bun", "hunk", "diff", "--cursor-line", "sparkles"])).rejects.toThrow(
      "Invalid cursor line style: sparkles",
    );
  });

  test("accepts --experimental before the review command", async () => {
    const parsed = await parseCli(["bun", "hunk", "--experimental", "diff"]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      options: { experimental: true },
    });
  });

  test("uses --fast alone as the shortest fast working-tree review", async () => {
    expect(await parseCli(["bun", "hunk", "--fast"])).toMatchObject({
      kind: "vcs",
      staged: false,
      options: { fast: true },
    });
  });

  test("accepts --fast before or after a review command", async () => {
    const prefixed = await parseCli(["bun", "hunk", "--fast", "diff"]);
    const commandOption = await parseCli(["bun", "hunk", "diff", "--fast"]);

    expect(prefixed).toMatchObject({ kind: "vcs", options: { fast: true } });
    expect(commandOption).toMatchObject({ kind: "vcs", options: { fast: true } });
  });

  test("routes shorthand diff options through the diff parser", async () => {
    expect(await parseCli(["bun", "hunk", "--fast", "--staged"])).toMatchObject({
      kind: "vcs",
      staged: true,
      options: { fast: true },
    });
    expect(await parseCli(["bun", "hunk", "--fast", "--watch"])).toMatchObject({
      kind: "vcs",
      options: { fast: true, watch: true },
    });
    expect(await parseCli(["bun", "hunk", "--fast", "--theme", "nord"])).toMatchObject({
      kind: "vcs",
      options: { fast: true, theme: "nord" },
    });
  });

  test("routes shorthand targets and direct file pairs through the diff parser", async () => {
    expect(await parseCli(["bun", "hunk", "--fast", "HEAD"])).toMatchObject({
      kind: "vcs",
      range: "HEAD",
      options: { fast: true },
    });

    const dir = createTempDir("hunk-fast-files-");
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "export const answer = 1;\n");
    writeFileSync(right, "export const answer = 2;\n");

    expect(await parseCli(["bun", "hunk", "--fast", "--files", left, right])).toMatchObject({
      kind: "diff",
      left,
      right,
      options: { fast: true },
    });
  });

  test("keeps top-level help and version handling ahead of --fast shorthand", async () => {
    const help = await parseCli(["bun", "hunk", "--fast", "--help"]);
    const version = await parseCli(["bun", "hunk", "--fast", "--version"]);

    expect(help).toMatchObject({ kind: "help" });
    expect(version).toEqual({ kind: "help", text: `${resolveCliVersion()}\n` });
  });

  test("accepts leading --fast and --experimental in either order", async () => {
    for (const flags of [
      ["--fast", "--experimental"],
      ["--experimental", "--fast"],
    ]) {
      expect(await parseCli(["bun", "hunk", ...flags, "show"])).toMatchObject({
        kind: "show",
        options: { experimental: true, fast: true },
      });
    }
  });

  test("preserves leading review flags interleaved with extension bootstrap flags", async () => {
    for (const flags of [
      ["--extension", "./review.ts", "--fast", "--experimental"],
      ["--fast", "--extension", "./review.ts", "--experimental"],
      ["--experimental", "--no-extensions", "--fast"],
    ]) {
      const parsed = await parseCli(["bun", "hunk", ...flags, "show"]);
      expect(parsed).toMatchObject({
        kind: "show",
        options: { experimental: true, fast: true },
      });
      if (parsed.kind !== "show") {
        throw new Error("Expected show command input.");
      }
      expect(parsed.options.extensions).toBe(flags.includes("--no-extensions") ? false : undefined);
      expect(parsed.options.extensionPaths).toEqual(
        flags.includes("--extension") ? ["./review.ts"] : undefined,
      );
    }
  });

  test("keeps fast disabled by default and treats it as a pathspec after --", async () => {
    const normal = await parseCli(["bun", "hunk", "diff"]);
    const pathspec = await parseCli(["bun", "hunk", "diff", "--", "--fast"]);

    expect(normal).toMatchObject({ kind: "vcs", options: { fast: undefined } });
    expect(pathspec).toMatchObject({
      kind: "vcs",
      pathspecs: ["--fast"],
      options: { fast: undefined },
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

  test("parses sidebar toggles", async () => {
    const shown = await parseCli(["bun", "hunk", "diff", "--sidebar"]);
    const hidden = await parseCli(["bun", "hunk", "diff", "--no-sidebar"]);
    const unset = await parseCli(["bun", "hunk", "diff"]);

    expect(shown).toMatchObject({ kind: "vcs", options: { sidebar: true } });
    expect(hidden).toMatchObject({ kind: "vcs", options: { sidebar: false } });
    expect(unset.kind === "vcs" ? unset.options.sidebar : "unset").toBeUndefined();
  });

  test("keeps paired-flag-shaped pathspecs after the option separator", async () => {
    const cases = [
      ["--exclude-untracked", "excludeUntracked"],
      ["--no-exclude-untracked", "excludeUntracked"],
      ["--line-numbers", "lineNumbers"],
      ["--no-line-numbers", "lineNumbers"],
      ["--wrap", "wrapLines"],
      ["--no-wrap", "wrapLines"],
      ["--hunk-headers", "hunkHeaders"],
      ["--no-hunk-headers", "hunkHeaders"],
      ["--sidebar", "sidebar"],
      ["--no-sidebar", "sidebar"],
      ["--agent-notes", "agentNotes"],
      ["--no-agent-notes", "agentNotes"],
      ["--transparent-bg", "transparentBackground"],
      ["--no-transparent-bg", "transparentBackground"],
      ["--extensions", "extensions"],
      ["--no-extensions", "extensions"],
    ] as const;

    for (const [pathspec, option] of cases) {
      const parsed = await parseCli(["bun", "hunk", "diff", "--", pathspec]);

      expect(parsed).toMatchObject({ kind: "vcs", pathspecs: [pathspec] });
      if (parsed.kind !== "vcs") throw new Error("Expected a VCS diff input.");
      expect(parsed.options[option]).toBeUndefined();
    }
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

  test("parses the explicit two-file comparison form", async () => {
    const dir = createTempDir("hunk-cli-files-");
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");

    const parsed = await parseCli([
      "bun",
      "hunk",
      "diff",
      "--files",
      left,
      right,
      "--mode",
      "stack",
    ]);

    expect(parsed).toMatchObject({
      kind: "diff",
      left,
      right,
      options: { mode: "stack" },
    });
  });

  test("treats two existing file paths as revisions unless --files is present", async () => {
    const dir = createTempDir("hunk-cli-file-shaped-revisions-");
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");
    writeFileSync(left, "before\n");
    writeFileSync(right, "after\n");

    expect(await parseCli(["bun", "hunk", "diff", left, right])).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: left, to: right },
    });
  });

  test("rejects malformed or mixed --files forms", async () => {
    for (const args of [
      ["--files", "one"],
      ["--files", "one", "two", "three"],
      ["--files", "one", "two", "--staged"],
      ["target", "--files", "one", "two"],
    ]) {
      await expect(parseCli(["bun", "hunk", "diff", ...args])).rejects.toThrow(
        "exactly two file paths",
      );
    }
  });

  test("parses two revision positionals as structured range endpoints", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff", "main", "feature"]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: "main", to: "feature" },
      staged: false,
    });
    expect(parsed).not.toHaveProperty("range", "main..feature");
  });

  test("keeps two revisions structured when pathspecs follow the separator", async () => {
    expect(
      await parseCli(["bun", "hunk", "diff", "main", "feature", "--", "src/app.ts"]),
    ).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: "main", to: "feature" },
      pathspecs: ["src/app.ts"],
    });
  });

  test("does not use filesystem existence to distinguish a revision from a pathspec", async () => {
    const dir = createTempDir("hunk-cli-revision-path-");
    const existing = join(dir, "branch-name");
    mkdirSync(existing);

    expect(await parseCli(["bun", "hunk", "diff", "HEAD", existing])).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: "HEAD", to: existing },
    });
    expect(await parseCli(["bun", "hunk", "diff", "HEAD", "--", existing])).toMatchObject({
      kind: "vcs",
      range: "HEAD",
      pathspecs: [existing],
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

  test("treats a range-shaped target plus one positional as two revision endpoints", async () => {
    expect(await parseCli(["bun", "hunk", "diff", "trunk()..@", ".github"])).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: "trunk()..@", to: ".github" },
    });
    expect(await parseCli(["bun", "hunk", "diff", "trunk()..@", "--", ".github"])).toMatchObject({
      kind: "vcs",
      range: "trunk()..@",
      pathspecs: [".github"],
    });
  });

  test("parses automatic and forced-static log options without review flags", async () => {
    expect(
      await parseCli([
        "bun",
        "hunk",
        "log",
        "main..feature",
        "--first-parent",
        "-n",
        "25",
        "--author",
        "Ada",
        "--color",
        "never",
        "--ascii",
        "--interactive",
        "--",
        "src/app.ts",
      ]),
    ).toEqual({
      kind: "history",
      revision: "main..feature",
      firstParent: true,
      maxCount: 25,
      author: "Ada",
      pathspecs: ["src/app.ts"],
      color: "never",
      format: "medium",
      ascii: true,
      static: false,
      extensionsEnabled: true,
      extensionPaths: [],
    });
    expect(await parseCli(["bun", "hunk", "log", "--static"])).toMatchObject({
      kind: "history",
      static: true,
    });
  });

  test("parses compact aliases, themes, and command-local extension disabling", async () => {
    expect(
      await parseCli(["bun", "hunk", "log", "--oneline", "--theme", "nord", "--no-extensions"]),
    ).toMatchObject({
      kind: "history",
      format: "compact",
      theme: "nord",
      extensionsEnabled: false,
    });
    expect(await parseCli(["bun", "hunk", "--no-extensions", "log"])).toMatchObject({
      kind: "history",
      extensionsEnabled: false,
    });
  });

  test("rejects unsupported log flags and conflicting traversal starts", async () => {
    await expect(parseCli(["bun", "hunk", "log", "--pretty=raw"])).rejects.toThrow(
      "unknown option",
    );
    await expect(parseCli(["bun", "hunk", "log", "HEAD", "--all"])).rejects.toThrow(
      "either a revision/range or --all",
    );
    await expect(parseCli(["bun", "hunk", "--fast", "log"])).rejects.toThrow("review command");
  });

  test("preserves opaque provider-planned history reviews through the private handoff", async () => {
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(
      await parseCli([
        "bun",
        "hunk",
        "diff",
        "--history-review",
        encoded({
          kind: "revision-range",
          fromRevisionId: "-opaque:parent/α",
          toRevisionId: "opaque:commit/β",
        }),
        "--vcs",
        "-custom",
      ]),
    ).toMatchObject({
      kind: "vcs",
      rangeEndpoints: { from: "-opaque:parent/α", to: "opaque:commit/β" },
      options: { vcs: "-custom" },
    });
    expect(
      await parseCli([
        "bun",
        "hunk",
        "show",
        "--history-review",
        encoded({ kind: "revision-show", revisionId: "-opaque:root/γ" }),
        "--vcs",
        "demo",
      ]),
    ).toMatchObject({
      kind: "show",
      ref: "-opaque:root/γ",
      options: { vcs: "demo" },
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

  test("prints a named bundled skill path, by name or alias", async () => {
    for (const requested of ["hunk-extensions", "extensions"]) {
      const parsed = await parseCli(["bun", "hunk", "skill", "path", requested]);

      expect(parsed.kind).toBe("help");
      if (parsed.kind !== "help") {
        throw new Error("Expected bundled skill path output.");
      }

      expect(parsed.text).toEndWith(`${join("skills", "hunk-extensions", "SKILL.md")}\n`);
    }
  });

  test("prints skill help for hunk skill --help", async () => {
    const parsed = await parseCli(["bun", "hunk", "skill", "--help"]);

    expect(parsed).toEqual({
      kind: "help",
      text: [
        "Usage: hunk skill path [name]",
        "",
        "Print a bundled Hunk skill path.",
        "Load or symlink that file in your coding agent to keep it in sync across Hunk upgrades.",
        "",
        "Skills:",
        `  hunk-review (default, "review")   review a live Hunk session with \`hunk session\` commands`,
        `  hunk-extensions ("extensions")    build extensions against the hunkdiff/extension API`,
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

  test("parses session context by direct session id", async () => {
    expect(await parseCli(["bun", "hunk", "session", "context", "session-1", "--json"])).toEqual({
      kind: "session",
      action: "context",
      selector: { sessionId: "session-1" },
      output: "json",
    });
  });

  test("keeps --repo provider-neutral while canonicalizing the selected subdirectory", async () => {
    const repoRoot = realpathSync.native(createTempDir("hunk-cli-repo-"));
    mkdirSync(join(repoRoot, ".git"));
    const subdir = join(repoRoot, "packages", "app");
    mkdirSync(subdir, { recursive: true });

    const parsed = await parseCli(["bun", "hunk", "session", "get", "--repo", subdir]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "get",
      selector: { repoRoot: realpathSync.native(subdir) },
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

  test("keeps structured endpoints through nested session reload parsing", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "reload",
      "session-1",
      "--",
      "diff",
      "main",
      "feature",
      "--",
      "src/app.ts",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "reload",
      selector: { sessionId: "session-1" },
      nextInput: {
        kind: "vcs",
        rangeEndpoints: { from: "main", to: "feature" },
        pathspecs: ["src/app.ts"],
      },
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

  test("keeps session reload --repo provider-neutral for subdirectories", async () => {
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
      selector: { repoRoot: realpathSync.native(subdir) },
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

  test("parses markup render with defaults and options", async () => {
    expect(await parseCli(["bun", "hunk", "markup", "render"])).toEqual({
      kind: "markup-render",
      file: "-",
      width: 56,
      color: "auto",
      theme: undefined,
      json: false,
    });

    expect(
      await parseCli([
        "bun",
        "hunk",
        "markup",
        "render",
        "note.stml",
        "--width",
        "72",
        "--color",
        "never",
        "--theme",
        "midnight",
        "--json",
      ]),
    ).toEqual({
      kind: "markup-render",
      file: "note.stml",
      width: 72,
      color: "never",
      theme: "midnight",
      json: true,
    });
  });

  test("rejects invalid markup render color modes and unknown markup subcommands", async () => {
    await expect(
      parseCli(["bun", "hunk", "markup", "render", "-", "--color", "sometimes"]),
    ).rejects.toThrow("--color must be auto, always, or never.");
    await expect(parseCli(["bun", "hunk", "markup", "bogus"])).rejects.toThrow(
      "Supported markup subcommands are render and guide.",
    );
  });

  test("parses markup guide", async () => {
    expect(await parseCli(["bun", "hunk", "markup", "guide"])).toEqual({ kind: "markup-guide" });
  });

  test("parses session comment add with --markup", async () => {
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
      "7",
      "--summary",
      "Rendered note",
      "--markup",
      "<box border><b>hot path</b></box>",
    ]);

    expect(parsed).toMatchObject({
      kind: "session",
      action: "comment-add",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      side: "new",
      line: 7,
      summary: "Rendered note",
      markup: "<box border><b>hot path</b></box>",
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

  test("parses session highlight add with defaults", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "highlight",
      "add",
      "session-1",
      "--file",
      "src/App.tsx",
      "--new-line",
      "42",
      "--start",
      "0",
      "--end",
      "13",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "highlight-add",
      selector: { sessionId: "session-1" },
      filePath: "src/App.tsx",
      side: "new",
      line: 42,
      start: 0,
      end: 13,
      reveal: false,
      output: "text",
    });
  });

  test("parses session highlight add with tone, old side, and focus", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "highlight",
      "add",
      "--repo",
      "/tmp/repo",
      "--file",
      "src/App.tsx",
      "--old-line",
      "7",
      "--start",
      "6",
      "--end",
      "19",
      "--tone",
      "warning",
      "--focus",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "highlight-add",
      selector: { repoRoot: resolve("/tmp/repo") },
      filePath: "src/App.tsx",
      side: "old",
      line: 7,
      start: 6,
      end: 19,
      tone: "warning",
      reveal: true,
      output: "json",
    });
  });

  test("rejects session highlight add with an empty range, bad tone, or missing target", async () => {
    const base = [
      "bun",
      "hunk",
      "session",
      "highlight",
      "add",
      "session-1",
      "--file",
      "src/App.tsx",
    ];

    await expect(
      parseCli([...base, "--new-line", "42", "--start", "5", "--end", "5"]),
    ).rejects.toThrow("Highlight --end must be greater than --start");
    await expect(
      parseCli([...base, "--new-line", "42", "--start", "0", "--end", "4", "--tone", "loud"]),
    ).rejects.toThrow("Highlight tone must be one of match, current, info, warning, error, dim.");
    await expect(parseCli([...base, "--start", "0", "--end", "4"])).rejects.toThrow(
      "Specify exactly one highlight target: --old-line <n> or --new-line <n>.",
    );
    await expect(
      parseCli([...base, "--new-line", "42", "--start", "-1", "--end", "4"]),
    ).rejects.toThrow();
  });

  test("parses session highlight clear globally and per file", async () => {
    expect(await parseCli(["bun", "hunk", "session", "highlight", "clear", "session-1"])).toEqual({
      kind: "session",
      action: "highlight-clear",
      selector: { sessionId: "session-1" },
      output: "text",
    });

    expect(
      await parseCli([
        "bun",
        "hunk",
        "session",
        "highlight",
        "clear",
        "--repo",
        "/tmp/repo",
        "--file",
        "src/App.tsx",
        "--json",
      ]),
    ).toEqual({
      kind: "session",
      action: "highlight-clear",
      selector: { repoRoot: resolve("/tmp/repo") },
      filePath: "src/App.tsx",
      output: "json",
    });
  });

  test("rejects unknown session highlight subcommands", async () => {
    await expect(parseCli(["bun", "hunk", "session", "highlight", "paint"])).rejects.toThrow(
      "Supported highlight subcommands are add and clear.",
    );
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
      selector: { repoRoot: resolve("/tmp/repo") },
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

  test("parses session navigate with a comment id", async () => {
    const parsed = await parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "--repo",
      "/tmp/repo",
      "--comment",
      "comment-1",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "session",
      action: "navigate",
      selector: { repoRoot: resolve("/tmp/repo") },
      commentId: "comment-1",
      output: "json",
    });
  });

  test("rejects session navigate when --comment is combined with another selector", async () => {
    const conflictingOptions = [
      ["--file", "README.md"],
      ["--hunk", "1"],
      ["--old-line", "10"],
      ["--new-line", "10"],
      ["--next-comment"],
      ["--prev-comment"],
    ];

    for (const conflictingOption of conflictingOptions) {
      await expect(
        parseCli([
          "bun",
          "hunk",
          "session",
          "navigate",
          "session-1",
          "--comment",
          "comment-1",
          ...conflictingOption,
        ]),
      ).rejects.toThrow("Specify exactly one navigation selector");
    }
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

  test("rejects session navigate without a complete selector mode", async () => {
    await expect(
      parseCli(["bun", "hunk", "session", "navigate", "session-1", "--hunk", "1"]),
    ).rejects.toThrow("Specify --comment <id>, --next-comment / --prev-comment, or --file <path>");
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

  test("preserves removed legacy aliases for extension lookup", async () => {
    expect(await parseCli(["bun", "hunk", "git"])).toEqual({
      kind: "extension-cli",
      commandName: "git",
      args: [],
      extensionPaths: [],
      extensionsEnabled: true,
    });
  });

  test("parses leading extension bootstrap flags without consuming command arguments", async () => {
    expect(
      await parseCli([
        "bun",
        "hunk",
        "--extension",
        "./first.ts",
        "--extension=./second.ts",
        "greptile",
        "sync",
        "--extension",
        "nested.ts",
        "--help",
      ]),
    ).toEqual({
      kind: "extension-cli",
      commandName: "greptile",
      args: ["sync", "--extension", "nested.ts", "--help"],
      extensionPaths: ["./first.ts", "./second.ts"],
      extensionsEnabled: true,
    });
  });

  test("does not consume another leading host flag as an extension path", async () => {
    for (const flag of ["--no-extensions", "--fast", "--experimental", "--extension"]) {
      await expect(parseCli(["bun", "hunk", "--extension", flag, "greptile"])).rejects.toThrow(
        "requires an extension entry path",
      );
    }
  });

  test("hard-disables unknown extension command lookup with a leading flag", async () => {
    expect(await parseCli(["bun", "hunk", "--no-extensions", "greptile", "sync"])).toEqual({
      kind: "extension-cli",
      commandName: "greptile",
      args: ["sync"],
      extensionPaths: [],
      extensionsEnabled: false,
    });
  });

  test("keeps leading extension bootstrap flags ahead of review pathspec separators", async () => {
    const diff = await parseCli([
      "bun",
      "hunk",
      "--extension",
      "./review.ts",
      "diff",
      "--",
      "src/a.ts",
    ]);
    expect(diff).toMatchObject({
      kind: "vcs",
      pathspecs: ["src/a.ts"],
      options: { extensionPaths: ["./review.ts"] },
    });

    const show = await parseCli(["bun", "hunk", "--no-extensions", "show", "--", "src/b.ts"]);
    expect(show).toMatchObject({
      kind: "show",
      pathspecs: ["src/b.ts"],
      options: { extensions: false },
    });
  });

  test("refuses leading extension bootstrap flags on built-ins that never load extensions", async () => {
    for (const command of [
      "session",
      "markup",
      "skill",
      "extension",
      "ext",
      "update",
      "daemon",
      "mcp",
    ]) {
      await expect(
        parseCli(["bun", "hunk", "--extension", "./review.ts", command, "list"]),
      ).rejects.toThrow(
        "`--extension` must be used with a Hunk review command or an extension CLI command",
      );
      await expect(parseCli(["bun", "hunk", "--no-extensions", command, "list"])).rejects.toThrow(
        "`--no-extensions` must be used with a Hunk review command or an extension CLI command",
      );
    }
  });

  test("keeps the stash subcommand ahead of leading extension bootstrap flags", async () => {
    expect(
      await parseCli(["bun", "hunk", "--extension", "./review.ts", "stash", "show", "stash@{1}"]),
    ).toMatchObject({
      kind: "stash-show",
      ref: "stash@{1}",
      options: { extensionPaths: ["./review.ts"] },
    });
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
    const logHelp = await expectHelp(["log", "--help"]);
    expect(logHelp).toContain("browse an attractive repository history");
    expect(logHelp).toContain("--static");
    expect(logHelp).not.toContain("--interactive");
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
    expect(await expectHelp(["session", "context", "--help"])).toContain(
      "show the selected file and hunk",
    );
    expect(await expectHelp(["session", "review", "--help"])).toContain(
      "export the live review model",
    );
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

  test("renders the highlight overview and per-highlight-subcommand help", async () => {
    const overview = await expectHelp(["session", "highlight"]);
    expect(overview).toContain("hunk session highlight add");
    expect(overview).toBe(await expectHelp(["session", "highlight", "--help"]));
    expect(await expectHelp(["session", "highlight", "add", "--help"])).toContain(
      "paint one attention mark",
    );
    expect(await expectHelp(["session", "highlight", "clear", "--help"])).toContain(
      "clear agent attention marks",
    );
  });
});

describe("parseCli argument validation", () => {
  /** Parse one numeric session-navigation flag through the public CLI parser. */
  function parseTestNavigationTarget(flag: "--hunk" | "--old-line" | "--new-line", value: string) {
    return parseCli([
      "bun",
      "hunk",
      "session",
      "navigate",
      "session-1",
      "--file",
      "README.md",
      flag,
      value,
    ]);
  }

  test("rejects invalid tab widths", async () => {
    for (const value of ["0", "17", "4x"]) {
      await expect(parseCli(["bun", "hunk", "diff", "--tab-width", value])).rejects.toThrow(
        "Invalid tab width",
      );
    }
  });

  test("parses file and hunk gaps and rejects values outside 0-8", async () => {
    const parsed = await parseCli(["bun", "hunk", "diff", "--file-gap", "3", "--hunk-gap", "1"]);

    expect(parsed).toMatchObject({
      kind: "vcs",
      options: { fileGap: 3, hunkGap: 1 },
    });

    await expect(parseCli(["bun", "hunk", "diff", "--file-gap", "9"])).rejects.toThrow(
      "Invalid file gap",
    );
    await expect(parseCli(["bun", "hunk", "diff", "--hunk-gap", "abc"])).rejects.toThrow(
      "Invalid hunk gap",
    );
  });

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

  test.each(["1", "42", "9007199254740991"])(
    "accepts positive integer navigation target %s",
    async (value) => {
      await expect(parseTestNavigationTarget("--hunk", value)).resolves.toMatchObject({
        hunkNumber: Number(value),
      });
    },
  );

  test.each(["0", "-1", "1.5", "1e3", "12abc", "9007199254740992"])(
    "rejects malformed positive integer navigation target %s",
    async (value) => {
      await expect(parseTestNavigationTarget("--hunk", value)).rejects.toThrow(
        `Invalid positive integer: ${value}`,
      );
    },
  );

  test.each(["--hunk", "--old-line", "--new-line"])(
    "rejects a partially numeric value for %s",
    async (flag) => {
      await expect(parseTestNavigationTarget(flag, "12abc")).rejects.toThrow(
        "Invalid positive integer: 12abc",
      );
    },
  );

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

  test("rejects prefixed review flags for non-review commands", async () => {
    await expect(parseCli(["bun", "hunk", "--experimental", "session", "list"])).rejects.toThrow(
      "must be used with a Hunk review command",
    );
    await expect(parseCli(["bun", "hunk", "--fast", "session", "list"])).rejects.toThrow(
      "`--fast` must be used with a Hunk review command",
    );
  });

  test("rejects top-level tokens no extension can register", async () => {
    for (const command of ["--bogus", "-x", "UPPER", "under_score"]) {
      await expect(parseCli(["bun", "hunk", command])).rejects.toThrow(
        `Unknown command: ${command}`,
      );
    }
  });

  test("rejects unknown skill, daemon, stash, and comment subcommands", async () => {
    await expect(parseCli(["bun", "hunk", "skill", "bogus"])).rejects.toThrow(
      "Only `hunk skill path` is supported.",
    );
    await expect(parseCli(["bun", "hunk", "skill", "path", "bogus"])).rejects.toThrow(
      'Unknown skill "bogus". Bundled skills are hunk-review and hunk-extensions.',
    );
    // Maintainer-only skills are not bundled, so naming one is not a path lookup.
    await expect(parseCli(["bun", "hunk", "skill", "path", "launch-video"])).rejects.toThrow(
      'Unknown skill "launch-video".',
    );
    await expect(
      parseCli(["bun", "hunk", "skill", "path", "hunk-review", "extra"]),
    ).rejects.toThrow("`hunk skill path` accepts at most one skill name.");
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
  test("scopes reload help flags around the nested command separator", async () => {
    const outerHelp = await parseCli([
      "bun",
      "hunk",
      "session",
      "reload",
      "--help",
      "--",
      "show",
      "--help",
    ]);
    expect(outerHelp).toMatchObject({
      kind: "help",
      text: expect.stringContaining("replace the contents of one live Hunk session"),
    });

    await expect(
      parseCli(["bun", "hunk", "session", "reload", "session-1", "--", "show", "--help"]),
    ).rejects.toThrow("Session reload requires a Hunk review command after --");

    expect(
      await parseCli([
        "bun",
        "hunk",
        "session",
        "reload",
        "session-1",
        "--",
        "show",
        "HEAD",
        "--",
        "--help",
      ]),
    ).toMatchObject({
      kind: "session",
      action: "reload",
      nextInput: { kind: "show", ref: "HEAD", pathspecs: ["--help"] },
    });
  });

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

describe("parseCli extension flags", () => {
  test("defaults to leaving extension options unset", async () => {
    const parsed = await parseCli(["bun", "hunk", "show", "HEAD"]);

    if (parsed.kind !== "show") {
      throw new Error("Expected a show command.");
    }

    expect(parsed.options.extensions).toBeUndefined();
    expect(parsed.options.extensionPaths).toBeUndefined();
  });

  test("parses --no-extensions into a disabled extension option", async () => {
    const parsed = await parseCli(["bun", "hunk", "show", "HEAD", "--no-extensions"]);

    if (parsed.kind !== "show") {
      throw new Error("Expected a show command.");
    }

    expect(parsed.options.extensions).toBe(false);
  });

  test("collects repeated --extension paths in order", async () => {
    const first = join("dev", "copy-as.ts");
    const second = join("dev", "blame.ts");
    const parsed = await parseCli([
      "bun",
      "hunk",
      "patch",
      "-",
      "--extension",
      first,
      "--extension",
      second,
    ]);

    if (parsed.kind !== "patch") {
      throw new Error("Expected a patch command.");
    }

    expect(parsed.options.extensionPaths).toEqual([first, second]);
  });

  test("documents the extension flags in top-level help", async () => {
    const parsed = await parseCli(["bun", "hunk"]);

    if (parsed.kind !== "help") {
      throw new Error("Expected top-level help output.");
    }

    expect(parsed.text).toContain("--extension <path>");
    expect(parsed.text).toContain("--no-extensions");
  });
});

describe("parseCli extension management commands", () => {
  test("parses install with its source and confirmation flag", async () => {
    const parsed = await parseCli(["bun", "hunk", "extension", "install", "acme/hunk-ext@v1"]);
    expect(parsed).toEqual({
      kind: "extension-manage",
      action: "install",
      source: "acme/hunk-ext@v1",
      yes: false,
    });

    const confirmed = await parseCli([
      "bun",
      "hunk",
      "extension",
      "install",
      "acme/hunk-ext",
      "--yes",
    ]);
    expect(confirmed).toEqual({
      kind: "extension-manage",
      action: "install",
      source: "acme/hunk-ext",
      yes: true,
    });
  });

  test("parses list, update, and remove with their targets", async () => {
    expect(await parseCli(["bun", "hunk", "extension", "list"])).toEqual({
      kind: "extension-manage",
      action: "list",
    });
    expect(await parseCli(["bun", "hunk", "extension", "update"])).toEqual({
      kind: "extension-manage",
      action: "update",
      name: undefined,
    });
    expect(await parseCli(["bun", "hunk", "extension", "update", "hunk-ext"])).toEqual({
      kind: "extension-manage",
      action: "update",
      name: "hunk-ext",
    });
    expect(await parseCli(["bun", "hunk", "extension", "remove", "hunk-ext"])).toEqual({
      kind: "extension-manage",
      action: "remove",
      name: "hunk-ext",
    });
    // Familiar spellings from other package managers resolve to remove.
    expect(await parseCli(["bun", "hunk", "extension", "uninstall", "hunk-ext"])).toEqual({
      kind: "extension-manage",
      action: "remove",
      name: "hunk-ext",
    });
  });

  test("accepts ext as an alias for extension", async () => {
    expect(await parseCli(["bun", "hunk", "ext", "list"])).toEqual({
      kind: "extension-manage",
      action: "list",
    });
    expect(await parseCli(["bun", "hunk", "ext", "install", "acme/hunk-ext", "--yes"])).toEqual({
      kind: "extension-manage",
      action: "install",
      source: "acme/hunk-ext",
      yes: true,
    });
  });

  test("shows extension help for the bare command and rejects unknown subcommands", async () => {
    const parsed = await parseCli(["bun", "hunk", "extension"]);
    expect(parsed.kind).toBe("help");
    if (parsed.kind === "help") {
      expect(parsed.text).toContain("hunk extension install <source>");
      expect(parsed.text).toContain("only install repositories you trust");
      expect(parsed.text).toContain("hunk-extension");
    }

    expect(parseCli(["bun", "hunk", "extension", "publish"])).rejects.toThrow(
      /Supported extension subcommands/,
    );
  });

  test("session reload refuses to nest an extension management command", async () => {
    expect(
      parseCli(["bun", "hunk", "session", "reload", "abc123", "--", "extension", "list"]),
    ).rejects.toThrow(/review command/);
  });
});
