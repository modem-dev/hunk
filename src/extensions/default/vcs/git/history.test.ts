import { describe, expect, test } from "bun:test";
import { createGitVcsAdapter } from "./index";
import { buildGitHistoryArgs, gitHistoryUsesBoundaryTopology, parseGitHistory } from "./history";

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
  });

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
