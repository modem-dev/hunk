import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJjVcsAdapter } from "./index";
import {
  buildJjHistoryArgs,
  buildJjHistoryRevset,
  jjHistoryUsesBoundaryTopology,
  openJjHistory,
  parseJjHistory,
} from "./history";

const tempDirs: string[] = [];
const jjTest = Bun.which("jj") ? test : test.skip;

/** Create a real JJ-only workspace without a colocated `.git` directory. */
function createJjOnlyTestRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-history-")));
  tempDirs.push(repo);
  const init = Bun.spawnSync(["jj", "git", "init", "--no-colocate", repo], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  return repo;
}

/** Run JJ with a deterministic identity for fixture commits. */
function jj(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "jj",
      "--config",
      'user.name="Ada Lovelace"',
      "--config",
      'user.email="ada@example.com"',
      ...args,
    ],
    { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

afterEach(() => {
  for (const repo of tempDirs.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("Jujutsu history production", () => {
  test("builds a provider-owned revset and preserves literal filesets", () => {
    expect(
      buildJjHistoryArgs({
        revision: "main..@",
        firstParent: true,
        maxCount: 12,
        author: 'Ada "A"',
        grep: "parser",
        since: "2026-01-01",
        until: "2026-02-01",
        pathspecs: ["src/file with spaces.ts", "--not-an-option"],
      }),
    ).toEqual([
      "--ignore-working-copy",
      "--no-pager",
      "--color",
      "never",
      "log",
      "--no-graph",
      "--revisions",
      '(first_ancestors((main..@)) ~ root()) & author(substring:"Ada \\"A\\"") & description(substring:"parser") & author_date(after:"2026-01-01") & author_date(before:"2026-02-01")',
      "--template",
      expect.any(String),
      "--limit",
      "12",
      "--",
      "src/file with spaces.ts",
      "--not-an-option",
    ]);
    expect(buildJjHistoryRevset({ all: true })).toBe("(ancestors(visible_heads()) ~ root())");
  });

  test("rejects option-like revisions", () => {
    expect(() => buildJjHistoryRevset({ revision: "--at-operation=@" })).toThrow(
      "Refused Jujutsu history revision",
    );
  });

  test("parses descriptions, logical ids, parents, and structured JJ refs", () => {
    const raw = [
      "a".repeat(40),
      "kkkkkkkk",
      "k".repeat(32),
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "Ada Lovelace",
      "ada@example.com",
      "2026-01-02T03:04:05+00:00",
      "Subject\n\nBody paragraph.\n",
      "1",
      `main\x1ffeature`,
      "main@git",
      "v1.0.0",
      "v1.0.0@origin",
    ].join("\0");
    expect(parseJjHistory(raw)).toEqual([
      {
        revisionId: "a".repeat(40),
        displayId: "kkkkkkkk",
        logicalId: "k".repeat(32),
        parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
        subject: "Subject",
        body: "Body paragraph.",
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authoredAt: "2026-01-02T03:04:05+00:00",
        decorations: [
          { kind: "head", label: "@" },
          { kind: "local-branch", label: "main" },
          { kind: "local-branch", label: "feature" },
          { kind: "remote-branch", label: "main@git" },
          { kind: "tag", label: "v1.0.0" },
          { kind: "tag", label: "v1.0.0@origin" },
        ],
      },
    ]);
  });

  test("keeps review parents but marks filtered topology as a boundary", () => {
    expect(jjHistoryUsesBoundaryTopology({})).toBe(false);
    expect(jjHistoryUsesBoundaryTopology({ revision: "main..@" })).toBe(false);
    expect(jjHistoryUsesBoundaryTopology({ pathspecs: ["src"] })).toBe(true);
    expect(jjHistoryUsesBoundaryTopology({ author: "Ada" })).toBe(true);

    const raw = [
      "a".repeat(40),
      "aaaaaaaa",
      "k".repeat(32),
      "b".repeat(40),
      "Ada",
      "",
      "2026-01-01T00:00:00+00:00",
      "Commit\n",
      "0",
      "",
      "",
      "",
      "",
    ].join("\0");
    const parsed = parseJjHistory(raw, false, true)[0]!;
    expect(parsed.parentRevisionIds).toEqual(["b".repeat(40)]);
    expect(parsed.graphParentRevisionIds).toEqual([]);
  });

  test("drops JJ's synthetic root and excluded merge parents", () => {
    const raw = [
      "a".repeat(40),
      "aaaaaaaa",
      "k".repeat(32),
      `${"b".repeat(40)} ${"0".repeat(40)} ${"c".repeat(40)}`,
      "Ada",
      "",
      "2026-01-01T00:00:00+00:00",
      "Commit\n",
      "0",
      "",
      "",
      "",
      "",
    ].join("\0");
    expect(parseJjHistory(raw, true)[0]!.parentRevisionIds).toEqual(["b".repeat(40)]);
  });

  test("owns default and explicitly selected parent review semantics", async () => {
    const history = createJjVcsAdapter().history!;
    for (const parentRevisionIds of [[], ["b".repeat(40)], ["b".repeat(40), "c".repeat(40)]]) {
      const commit = {
        revisionId: "a".repeat(40),
        displayId: "aaaaaaaa",
        logicalId: "k".repeat(32),
        parentRevisionIds,
        subject: "Commit",
        authorName: "Ada",
        authoredAt: "2026-01-01T00:00:00+00:00",
        decorations: [],
      };
      expect(await history.planReview(commit)).toEqual({
        kind: "revision-show",
        revisionId: commit.revisionId,
      });
      if (parentRevisionIds[0]) {
        expect(
          await history.planReview(commit, undefined, {
            parentRevisionId: parentRevisionIds[0],
          }),
        ).toEqual({
          kind: "revision-range",
          fromRevisionId: parentRevisionIds[0],
          toRevisionId: commit.revisionId,
        });
      }
    }
  });

  jjTest(
    "streams bounded child-before-parent pages from a JJ-only repository",
    async () => {
      const repo = createJjOnlyTestRepo();
      expect(existsSync(join(repo, ".git"))).toBe(false);
      writeFileSync(join(repo, "history.txt"), "one\n");
      jj(repo, "commit", "-m", "First commit");
      writeFileSync(join(repo, "history.txt"), "two\n");
      jj(repo, "commit", "-m", "Second commit\n\nDetailed body.");
      jj(repo, "bookmark", "create", "main", "-r", "@-");
      jj(repo, "tag", "set", "v1.0.0", "-r", "@-");

      const source = openJjHistory({ maxCount: 4 }, { cwd: repo });
      const commits = [];
      for (;;) {
        const page = await source.read({ limit: 1 });
        expect(page.commits.length).toBeLessThanOrEqual(1);
        commits.push(...page.commits);
        if (page.done) break;
      }
      await source.close();

      expect(commits.map((commit) => commit.subject)).toEqual([
        "(no description set)",
        "Second commit",
        "First commit",
      ]);
      expect(commits[1]!.body).toBe("Detailed body.");
      expect(commits[1]!.displayId).toMatch(/^[k-z]{8}$/);
      expect(commits[1]!.logicalId).toMatch(/^[k-z]{32}$/);
      expect(commits[1]!.decorations).toContainEqual({ kind: "local-branch", label: "main" });
      expect(commits[1]!.decorations).toContainEqual({ kind: "tag", label: "v1.0.0" });
      for (let index = 0; index < commits.length; index += 1) {
        for (const parent of commits[index]!.parentRevisionIds) {
          const parentIndex = commits.findIndex((commit) => commit.revisionId === parent);
          if (parentIndex >= 0) expect(parentIndex).toBeGreaterThan(index);
        }
      }

      const filtered = openJjHistory({ pathspecs: ["history.txt"] }, { cwd: repo });
      const filteredPage = await filtered.read({ limit: 4 });
      await filtered.close();
      const filteredWithParent = filteredPage.commits.find(
        (commit) => commit.parentRevisionIds.length > 0,
      );
      expect(filteredWithParent?.parentRevisionIds).toHaveLength(1);
      expect(filteredWithParent?.graphParentRevisionIds).toEqual([]);

      const cancelled = openJjHistory({}, { cwd: repo });
      const abort = new AbortController();
      abort.abort(new Error("cancel fixture"));
      await expect(cancelled.read({ limit: 1, signal: abort.signal })).rejects.toThrow(
        "cancel fixture",
      );
      await cancelled.close();
    },
    20_000,
  );
});
