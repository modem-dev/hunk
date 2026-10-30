import { describe, expect, test } from "bun:test";
import {
  createTestSearchFile,
  searchTestAlpha as alpha,
  searchTestBeta as beta,
  searchTestBlock as block,
  searchTestInterleaved as interleaved,
  searchTestRepeated as repeated,
} from "../../../../../../../test/helpers/search-fixtures";
import {
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  lineOrderKey,
  parsePatchLines,
  stepToTarget,
  type SearchLayout,
} from "./search";

/** Label each target `side:line@start` so order assertions read like the screen. */
function labelTargets(
  files: Parameters<typeof findTargets>[0],
  query: string,
  layout: SearchLayout,
) {
  const compiled = compileQuery(query, "literal");
  if (!compiled.ok) throw new Error("query should compile");

  return findTargets(files, compiled.locate, layout).map(
    (target) => `${target.line.side}:${target.line.lineNumber}@${target.line.matchRange[0]}`,
  );
}

describe("parsePatchLines", () => {
  test("numbers both sides and groups lines by hunk", () => {
    const lines = parsePatchLines(alpha.patch);

    expect(lines.map((line) => [line.hunkIndex, line.side, line.lineNumber, line.text])).toEqual([
      [0, "new", 10, "const keep = 1;"],
      [0, "old", 11, "const removed = readConfig();"],
      [0, "new", 11, "const added = readConfig();"],
      [0, "new", 12, "const second = readConfig();"],
      [1, "new", 41, "untouched"],
      [1, "new", 42, "const late = 2;"],
    ]);
  });

  test("tags each line with its kind, Pierre group, and index within its kind", () => {
    const lines = parsePatchLines(
      ["@@ -1,3 +1,3 @@", " c1", "-d1", "+a1", "-d2", "+a2", " c2", "@@ -9 +9 @@", "-x"].join("\n"),
    );

    expect(lines.map((line) => [line.hunkIndex, line.kind, line.group, line.groupIndex])).toEqual([
      [0, "context", 0, 0],
      [0, "deletion", 1, 0],
      [0, "addition", 1, 0],
      [0, "deletion", 1, 1],
      [0, "addition", 1, 1],
      [0, "context", 2, 0],
      [1, "deletion", 0, 0],
    ]);
  });

  test("skips file headers and no-newline markers", () => {
    const lines = parsePatchLines(
      [
        "diff --git a/x b/x",
        "index 1..2",
        "@@ -1 +1 @@",
        "+only",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("only");
  });
});

describe("compileQuery", () => {
  test("is case-insensitive until the query carries uppercase", () => {
    const lower = compileQuery("readconfig", "literal");
    const upper = compileQuery("ReadConfig", "literal");

    expect(lower.ok && lower.locate("const x = ReadConfig();")).toEqual([[10, 20]]);
    expect(upper.ok && upper.locate("const x = readconfig();")).toEqual([]);
  });

  test("literal mode does not interpret regex metacharacters", () => {
    const compiled = compileQuery("readConfig(", "literal");

    expect(compiled.ok && compiled.locate("readConfig();")).toEqual([[0, 11]]);
  });

  test("regex mode compiles patterns and reports bad ones", () => {
    const compiled = compileQuery("read(Config|Value)", "regex");
    expect(compiled.ok && compiled.locate("a readValue()")).toEqual([[2, 11]]);

    const broken = compileQuery("read(", "regex");
    expect(broken.ok).toBe(false);
  });

  test("a zero-width regex match still marks a visible position", () => {
    const compiled = compileQuery("^", "regex");

    expect(compiled.ok && compiled.locate("anything")).toEqual([[0, 1]]);
  });

  test.each(["literal", "regex"] as const)("%s returns non-overlapping ranges", (mode) => {
    const compiled = compileQuery("aa", mode);
    if (!compiled.ok) throw new Error("query should compile");

    expect(compiled.locate("aaaaa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(compiled.locate("AAaa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(compiled.locate("none")).toEqual([]);
    expect(compiled.locate("aa")).toEqual([[0, 2]]);
  });

  test("zero-width regex matches advance and reset between lines, including at the end", () => {
    const compiled = compileQuery("(?=a)|$", "regex");
    if (!compiled.ok) throw new Error("query should compile");

    expect(compiled.locate("aa")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(compiled.locate("aa")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(compiled.locate("")).toEqual([[0, 1]]);
  });

  test.each(["literal", "regex"] as const)(
    "%s preserves surrounding whitespace and smart case",
    (mode) => {
      const compiled = compileQuery(" foo ", mode);
      const upper = compileQuery(" Foo ", mode);
      if (!compiled.ok || !upper.ok) throw new Error("query should compile");

      expect(compiled.locate("foo")).toEqual([]);
      expect(compiled.locate("foo ")).toEqual([]);
      expect(compiled.locate(" foo")).toEqual([]);
      expect(compiled.locate(" Foo ")).toEqual([[0, 5]]);
      expect(upper.locate(" foo ")).toEqual([]);
      expect(upper.locate(" Foo ")).toEqual([[0, 5]]);
    },
  );

  test("an empty query is refused", () => {
    expect(compileQuery("   ", "literal").ok).toBe(false);
  });
});

describe("lineOrderKey", () => {
  const deletion = { kind: "deletion", group: 1, groupIndex: 2 } as const;
  const addition = { kind: "addition", group: 1, groupIndex: 2 } as const;

  test("unified stacks deletions above additions; split pairs them by index", () => {
    expect(lineOrderKey(deletion, "unified")).toEqual([1, 0, 2]);
    expect(lineOrderKey(addition, "unified")).toEqual([1, 1, 2]);
    expect(lineOrderKey(deletion, "split")).toEqual([1, 2, 0]);
    expect(lineOrderKey(addition, "split")).toEqual([1, 2, 1]);
  });
});

describe("findTargets", () => {
  test("emits one target per occurrence, in stream order", () => {
    const compiled = compileQuery("readConfig", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    const targets = findTargets([alpha, beta], compiled.locate, "unified");

    expect(
      targets.map((target) => [target.path, target.hunkIndex, target.line.lineNumber]),
    ).toEqual([
      ["src/alpha.ts", 0, 11],
      ["src/alpha.ts", 0, 11],
      ["src/alpha.ts", 0, 12],
      ["src/beta.ts", 0, 2],
    ]);
  });

  test("gives every occurrence on a line its own target", () => {
    expect(labelTargets([repeated], "readConfig", "unified")).toEqual([
      "old:1@0",
      "old:1@14",
      "new:1@0",
      "new:1@14",
    ]);
  });

  test("orders a change block as unified stacks it and split pairs it", () => {
    expect(labelTargets([block], "foo", "unified")).toEqual([
      "new:1@4",
      "old:2@4",
      "old:3@4",
      "new:2@4",
      "new:3@4",
      "new:3@12",
    ]);
    expect(labelTargets([block], "foo", "split")).toEqual([
      "new:1@4",
      "old:2@4",
      "new:2@4",
      "old:3@4",
      "new:3@4",
      "new:3@12",
    ]);
  });

  test("treats interleaved deletions and additions as one change group", () => {
    const lines = (layout: SearchLayout) =>
      findTargets([interleaved], (text) => (text.includes("foo") ? [[2, 5]] : []), layout).map(
        (target) => target.line.text[0],
      );

    expect(lines("unified")).toEqual(["a", "c", "b", "d"]);
    expect(lines("split")).toEqual(["a", "b", "c", "d"]);
  });

  test("skips files with no patch text", () => {
    const compiled = compileQuery("anything", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    expect(
      findTargets([createTestSearchFile("file-0", "bin.png", "")], compiled.locate, "unified"),
    ).toEqual([]);
  });
});

describe("stepToTarget", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");
  // Ranks: [0,0,1,0,0,16] [0,0,1,1,0,14] [0,0,1,1,1,15] [1,0,1,1,0,0]
  const targets = findTargets([alpha, beta], compiled.locate, "unified");

  test("a hunk prefix moves strictly past that whole hunk", () => {
    expect(stepToTarget(targets, [0, 0], "forward")).toEqual({
      index: 3,
      wrapped: false,
    });
    expect(stepToTarget(targets, [1, 0], "backward")).toEqual({
      index: 2,
      wrapped: false,
    });
  });

  test("a line prefix steps between lines of one hunk", () => {
    expect(stepToTarget(targets, [0, 0, 1, 1, 0], "forward")).toEqual({
      index: 2,
      wrapped: false,
    });
    expect(stepToTarget(targets, [0, 0, 1, 1, 0], "backward")).toEqual({
      index: 0,
      wrapped: false,
    });
  });

  test("an exact rank steps to the adjacent occurrence", () => {
    const rank = targets[1]?.rank ?? [];

    expect(stepToTarget(targets, rank, "forward")).toEqual({
      index: 2,
      wrapped: false,
    });
    expect(stepToTarget(targets, rank, "backward")).toEqual({
      index: 0,
      wrapped: false,
    });
  });

  test("wraps at either end and reports it", () => {
    expect(stepToTarget(targets, targets[3]?.rank ?? [], "forward")).toEqual({
      index: 0,
      wrapped: true,
    });
    expect(stepToTarget(targets, targets[0]?.rank ?? [], "backward")).toEqual({
      index: 3,
      wrapped: true,
    });
  });

  test("a file prefix before its first hunk finds that file's own first match", () => {
    expect(stepToTarget(targets, [0, -1], "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
  });

  test("no position starts at the end the direction implies", () => {
    expect(stepToTarget(targets, null, "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
    expect(stepToTarget(targets, null, "backward")).toEqual({
      index: 3,
      wrapped: false,
    });
  });

  test("an empty target list has nowhere to go", () => {
    expect(stepToTarget([], [0, 0], "forward")).toBeNull();
  });
});

describe("collectFileMatchMarks", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");

  test.each(["literal", "regex"] as const)(
    "%s marks every occurrence and makes only the current one current",
    (mode) => {
      const query = compileQuery("readConfig", mode);
      if (!query.ok) throw new Error("query should compile");

      expect(
        collectFileMatchMarks(repeated, query.locate, {
          fileId: repeated.id,
          hunkIndex: 0,
          lineOffset: 0,
          matchStart: 14,
        }),
      ).toEqual([
        { side: "old", line: 1, range: [0, 10], tone: "match" },
        { side: "old", line: 1, range: [14, 24], tone: "current" },
        { side: "new", line: 1, range: [0, 10], tone: "match" },
        { side: "new", line: 1, range: [14, 24], tone: "match" },
      ]);
    },
  );

  test("marks every matching line on its own side with the matched extent", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, null);

    expect(marks).toEqual([
      { side: "old", line: 11, range: [16, 26], tone: "match" },
      { side: "new", line: 11, range: [14, 24], tone: "match" },
      { side: "new", line: 12, range: [15, 25], tone: "match" },
    ]);
  });

  test("gives the active target's own range the one current mark", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-0",
      hunkIndex: 0,
      lineOffset: 2,
      matchStart: 14,
    });

    expect(marks.map((mark) => mark.tone)).toEqual(["match", "current", "match"]);
  });

  test("a current target in another file marks nothing current here", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-1",
      hunkIndex: 0,
      lineOffset: 1,
      matchStart: 14,
    });

    expect(marks.every((mark) => mark.tone === "match")).toBe(true);
  });
});
