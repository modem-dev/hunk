import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitVcsAdapter } from "./index";
import {
  buildGitHistoryArgs,
  gitHistoryUsesBoundaryTopology,
  parseGitHistory,
  planGitHistoryRangeReview,
} from "./history";

describe("Git history production", () => {
  test("builds the strict supported query with literal pathspec separation", () => {
    expect(
      buildGitHistoryArgs({
        revision: "main..feature",
        all: true,
        firstParent: true,
        maxCount: 12,
        author: "Ada",
        grep: "parser",
        since: "2.weeks",
        until: "yesterday",
        pathspecs: ["src/file with spaces.ts", "--not-an-option"],
      }),
    ).toEqual([
      "log",
      "--topo-order",
      "--parents",
      "--no-show-signature",
      "--no-color",
      "--abbrev=8",
      "-z",
      "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b",
      "--all",
      "--first-parent",
      "--max-count=12",
      "--author=Ada",
      "--grep=parser",
      "--since=2.weeks",
      "--until=yesterday",
      "main..feature",
      "--",
      "src/file with spaces.ts",
      "--not-an-option",
    ]);
  });

  test("refuses option-like revisions", () => {
    expect(() => buildGitHistoryArgs({ revision: "--output=/tmp/pwn" })).toThrow(
      "Refused history revision",
    );
  });

  test("parses NUL-delimited commits and copies structured decorations", () => {
    const decorations = new Map([["a".repeat(40), [{ kind: "head" as const, label: "HEAD" }]]]);
    const text = [
      "a".repeat(40),
      "aaaaaaaa",
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "Ada Lovelace",
      "ada@example.com",
      "2026-01-02T03:04:05Z",
      "Merge work",
      "Detailed rationale.\n",
    ].join("\0");
    expect(parseGitHistory(text, decorations)).toEqual([
      {
        revisionId: "a".repeat(40),
        displayId: "aaaaaaaa",
        parentRevisionIds: ["b".repeat(40), "c".repeat(40)],
        subject: "Merge work",
        body: "Detailed rationale.\n",
        authorName: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authoredAt: "2026-01-02T03:04:05Z",
        decorations: [{ kind: "head", label: "HEAD" }],
      },
    ]);
  });

  test("marks repeated filtered gaps as graph boundaries without losing review parents", () => {
    expect(gitHistoryUsesBoundaryTopology({ author: "Ada" })).toBe(true);
    expect(gitHistoryUsesBoundaryTopology({ grep: "fix" })).toBe(true);
    expect(gitHistoryUsesBoundaryTopology({})).toBe(false);

    const record = (revision: string, parent: string, subject: string) =>
      [
        revision.repeat(40),
        revision.repeat(8),
        parent.repeat(40),
        "Ada",
        "ada@example.com",
        "2026-01-01T00:00:00Z",
        subject,
        "",
      ].join("\0");
    const commits = parseGitHistory(
      `${record("a", "d", "match one")}\0${record("b", "e", "match two")}\0${record("c", "f", "match three")}`,
      new Map(),
      false,
      true,
    );
    expect(commits.map((commit) => commit.parentRevisionIds)).toEqual([
      ["d".repeat(40)],
      ["e".repeat(40)],
      ["f".repeat(40)],
    ]);
    expect(commits.map((commit) => commit.graphParentRevisionIds)).toEqual([[], [], []]);
  });

  test("drops excluded secondary parents for first-parent topology", () => {
    const text = [
      "a".repeat(40),
      "aaaaaaaa",
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "Ada",
      "ada@example.com",
      "2026-01-01T00:00:00Z",
      "Merge",
      "",
    ].join("\0");
    expect(parseGitHistory(text, new Map(), true)[0]!.parentRevisionIds).toEqual(["b".repeat(40)]);
  });

  test("owns first-parent merge and root review semantics", async () => {
    const history = createGitVcsAdapter().history!;
    const root = {
      revisionId: "a".repeat(40),
      displayId: "aaaaaaaa",
      parentRevisionIds: [],
      subject: "Root",
      authorName: "Ada",
      authoredAt: "2026-01-01T00:00:00Z",
      decorations: [],
    };
    expect(await history.planReview(root)).toEqual({
      kind: "revision-show",
      revisionId: root.revisionId,
    });
    expect(
      await history.planReview({
        ...root,
        revisionId: "b".repeat(40),
        parentRevisionIds: ["c".repeat(40), "d".repeat(40)],
      }),
    ).toEqual({
      kind: "revision-range",
      fromRevisionId: "c".repeat(40),
      toRevisionId: "b".repeat(40),
    });
    expect(
      await history.planReview(
        {
          ...root,
          revisionId: "b".repeat(40),
          parentRevisionIds: ["c".repeat(40), "d".repeat(40)],
        },
        undefined,
        { parentRevisionId: "d".repeat(40) },
      ),
    ).toEqual({
      kind: "revision-range",
      fromRevisionId: "d".repeat(40),
      toRevisionId: "b".repeat(40),
    });
  });

  test("plans a root-inclusive direct range with Git's native empty tree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hunk-git-history-range-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git("init", "--quiet");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      writeFileSync(join(repo, "root.txt"), "root\n");
      git("add", "root.txt");
      git("commit", "--quiet", "-m", "root");
      const rootId = git("rev-parse", "HEAD");
      writeFileSync(join(repo, "newest.txt"), "newest\n");
      git("add", "newest.txt");
      git("commit", "--quiet", "-m", "newest");
      const newestId = git("rev-parse", "HEAD");
      const commit = (revisionId: string, parentRevisionIds: string[]) => ({
        revisionId,
        displayId: revisionId.slice(0, 8),
        parentRevisionIds,
        subject: revisionId,
        authorName: "Test",
        authoredAt: "2026-01-01T00:00:00Z",
        decorations: [],
      });
      const plan = await createGitVcsAdapter().history!.planRangeReview!(
        {
          newestCommit: commit(newestId, [rootId]),
          oldestCommit: commit(rootId, []),
        },
        { cwd: repo },
      );
      expect(plan).toMatchObject({ kind: "revision-range", toRevisionId: newestId });
      expect(plan.kind === "revision-range" && plan.fromRevisionId).toMatch(/^[0-9a-f]{40,64}$/);
      expect(
        git(
          "diff",
          "--name-only",
          `${plan.kind === "revision-range" ? plan.fromRevisionId : ""}..${newestId}`,
        ),
      ).toEqual("newest.txt\nroot.txt");

      writeFileSync(join(repo, "third.txt"), "third\n");
      git("add", "third.txt");
      git("commit", "--quiet", "-m", "third");
      const thirdId = git("rev-parse", "HEAD");
      expect(
        await createGitVcsAdapter().history!.planRangeReview!(
          {
            newestCommit: commit(thirdId, [newestId]),
            oldestCommit: commit(newestId, [rootId]),
          },
          { cwd: repo },
        ),
      ).toEqual({
        kind: "revision-range",
        fromRevisionId: rootId,
        toRevisionId: thirdId,
      });

      git("checkout", "--quiet", "-b", "side", rootId);
      writeFileSync(join(repo, "side.txt"), "side\n");
      git("add", "side.txt");
      git("commit", "--quiet", "-m", "side");
      const sideId = git("rev-parse", "HEAD");
      await expect(
        createGitVcsAdapter().history!.planRangeReview!(
          {
            newestCommit: commit(sideId, [rootId]),
            oldestCommit: commit(newestId, [rootId]),
          },
          { cwd: repo },
        ),
      ).rejects.toThrow("not on one Git ancestry path");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "cancels provider range planning without blocking the renderer",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "hunk-git-range-cancel-"));
      const executable = join(temp, "slow-git");
      writeFileSync(executable, "#!/bin/sh\nsleep 30\n");
      chmodSync(executable, 0o755);
      const controller = new AbortController();
      const revision = "a".repeat(40);
      const commit = {
        revisionId: revision,
        displayId: revision.slice(0, 8),
        parentRevisionIds: ["b".repeat(40)],
        subject: "commit",
        authorName: "Test",
        authoredAt: "2026-01-01T00:00:00Z",
        decorations: [],
      };

      try {
        const planning = planGitHistoryRangeReview(
          { newestCommit: commit, oldestCommit: commit },
          { cwd: temp, gitExecutable: executable, signal: controller.signal },
        );
        controller.abort(new Error("planning cancelled"));
        await expect(planning).rejects.toThrow("planning cancelled");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  test("rejects truncated records and invalid SHA object ids", () => {
    expect(() => parseGitHistory("id\0short\0parent")).toThrow("truncated history record");
    expect(() =>
      parseGitHistory(
        [
          "not-a-sha",
          "short",
          "",
          "Ada",
          "ada@example.com",
          "2026-01-01T00:00:00Z",
          "Bad",
          "",
        ].join("\0"),
      ),
    ).toThrow("invalid history object id");
  });
});
