import { describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path/posix";
import {
  buildReviewFlatSidebarEntries,
  buildReviewTreeSidebarEntries,
  formatReviewNoteBadge,
  formatReviewSidebarStat,
  reviewFileChangeGlyph,
  reviewFileLabelParts,
  reviewPathBasename,
  reviewPathDirname,
  reviewSidebarBadges,
  reviewSidebarFileName,
  type ReviewSidebarFileEntry,
} from "./fileLabels";

const PATHS = [
  "",
  "a",
  "a/",
  "a/b",
  "a/b/",
  "a//b",
  "/",
  "//",
  "///a",
  "/a",
  "/a/b.ts",
  "//server/share/x.ts",
  "./x",
  "../x/y",
  "src/ü/セッション.ts",
  "a b/c d.ts",
];

/** A minimal sidebar row for projection tests. */
function createTestEntry(path: string, depth: number): ReviewSidebarFileEntry {
  return {
    kind: "file",
    id: path,
    name: reviewSidebarFileName(path),
    depth,
    agentCommentsText: null,
    additionsText: null,
    deletionsText: null,
    changeType: "change",
    isUntracked: false,
  };
}

describe("review path helpers", () => {
  // Intent: the shared helpers replace `node:path/posix` for a browser bundle, so they must
  // answer exactly as it does, roots and repeated separators included.
  test("match POSIX basename and dirname", () => {
    for (const path of PATHS) {
      expect([path, reviewPathBasename(path)]).toEqual([path, basename(path)]);
      expect([path, reviewPathDirname(path)]).toEqual([path, dirname(path)]);
    }
  });
});

describe("review file labels and badges", () => {
  // Intent: E1 — zeros are hidden and a truncated count is marked, in one formatter.
  test("hide zero stats and mark a truncated count", () => {
    expect(formatReviewSidebarStat("+", 0)).toBeNull();
    expect(formatReviewSidebarStat("+", 12, true)).toBe("+12+");
    expect(formatReviewSidebarStat("-", 3)).toBe("-3");
    expect(formatReviewNoteBadge(0)).toBeNull();
    expect(formatReviewNoteBadge(2)).toBe("*2");
  });

  test("order badges note first", () => {
    expect(
      reviewSidebarBadges({ agentCommentsText: "*1", additionsText: "+2", deletionsText: null }),
    ).toEqual([
      { kind: "agent-comment", text: "*1" },
      { kind: "addition", text: "+2" },
    ]);
  });

  test("name renames filename-first and keep one directory for a local rename", () => {
    expect(reviewSidebarFileName("src/b.ts", "src/a.ts")).toBe("a.ts -> b.ts");
    expect(reviewSidebarFileName("lib/a.ts", "src/a.ts")).toBe("a.ts");
    expect(
      reviewFileLabelParts({
        path: "src/b.ts",
        previousPath: "src/a.ts",
        changeKind: "rename-pure",
        untracked: false,
      }),
    ).toEqual({ filename: "src/a.ts -> b.ts", stateLabel: null });
    expect(reviewFileLabelParts({ path: "x.ts", changeKind: "new", untracked: true })).toEqual({
      filename: "x.ts",
      stateLabel: " (untracked)",
    });
  });

  test("letter every change kind, untracked first", () => {
    expect(reviewFileChangeGlyph("new", false).glyph).toBe("A");
    expect(reviewFileChangeGlyph("deleted", false).glyph).toBe("D");
    expect(reviewFileChangeGlyph("rename-changed", false).glyph).toBe("R");
    expect(reviewFileChangeGlyph("change", false).glyph).toBe("M");
    expect(reviewFileChangeGlyph("new", true)).toEqual({ glyph: "?", role: "fileUntracked" });
  });
});

describe("review sidebar projections", () => {
  // Intent: files are never regrouped away from review order, so a directory reappears
  // when review order leaves it and comes back.
  test("keep review order in both projections", () => {
    const files = ["src/a.ts", "lib/b.ts", "src/c.ts"];
    const input = { files, pathOf: (path: string) => path, entryOf: createTestEntry };

    expect(buildReviewFlatSidebarEntries(input).map((entry) => entry.id)).toEqual([
      "group:src:0",
      "src/a.ts",
      "group:lib:1",
      "lib/b.ts",
      "group:src:2",
      "src/c.ts",
    ]);
    expect(
      buildReviewTreeSidebarEntries(input).map((entry) =>
        entry.kind === "directory" ? `${entry.path}/(${entry.descendantFileCount})` : entry.id,
      ),
    ).toEqual(["src/(1)", "src/a.ts", "lib/(1)", "lib/b.ts", "src/(1)", "src/c.ts"]);
  });
});
