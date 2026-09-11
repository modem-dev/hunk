import { describe, expect, test } from "bun:test";
import {
  createTestSearchFile,
  searchTestAlpha as alpha,
  searchTestBeta as beta,
  searchTestRepeated as repeated,
} from "../../../../../../../test/helpers/search-fixtures";
import {
  buildFileOrder,
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  parsePatchLines,
  stepToTarget,
} from "./search";

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

describe("findTargets", () => {
  test("collapses every match in a hunk into one target, in stream order", () => {
    const compiled = compileQuery("readConfig", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    const targets = findTargets([alpha, beta], compiled.locate);

    expect(
      targets.map((target) => [
        target.path,
        target.hunkIndex,
        target.count,
        target.line.lineNumber,
      ]),
    ).toEqual([
      ["src/alpha.ts", 0, 3, 11],
      ["src/beta.ts", 0, 1, 2],
    ]);
  });

  test("skips files with no patch text", () => {
    const compiled = compileQuery("anything", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    expect(findTargets([createTestSearchFile("file-0", "bin.png", "")], compiled.locate)).toEqual(
      [],
    );
  });
});

describe("stepToTarget", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");
  const files = [alpha, beta];
  const targets = findTargets(files, compiled.locate);
  const order = buildFileOrder(files);

  test("moves strictly forward from the current hunk", () => {
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: 0 }, "forward")).toEqual({
      index: 1,
      wrapped: false,
    });
  });

  test("wraps at the end and reports it", () => {
    expect(stepToTarget(targets, order, { fileId: "file-1", hunkIndex: 0 }, "forward")).toEqual({
      index: 0,
      wrapped: true,
    });
  });

  test("walks backward and wraps at the start", () => {
    expect(stepToTarget(targets, order, { fileId: "file-1", hunkIndex: 0 }, "backward")).toEqual({
      index: 0,
      wrapped: false,
    });
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: 0 }, "backward")).toEqual({
      index: 1,
      wrapped: true,
    });
  });

  test("a file selected with no hunk finds that file's own first match", () => {
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: null }, "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
  });

  test("no selection starts at the end the direction implies", () => {
    expect(stepToTarget(targets, order, { fileId: null, hunkIndex: null }, "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
    expect(stepToTarget(targets, order, { fileId: null, hunkIndex: null }, "backward")).toEqual({
      index: 1,
      wrapped: false,
    });
  });

  test("an empty target list has nowhere to go", () => {
    expect(stepToTarget([], order, { fileId: "file-0", hunkIndex: 0 }, "forward")).toBeNull();
  });
});

describe("collectFileMatchMarks", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");

  test.each(["literal", "regex"] as const)(
    "%s marks every occurrence but keeps only the first landed range current",
    (mode) => {
      const query = compileQuery("readConfig", mode);
      if (!query.ok) throw new Error("query should compile");

      expect(
        collectFileMatchMarks(repeated, query.locate, {
          fileId: repeated.id,
          hunkIndex: 0,
          lineOffset: 0,
        }),
      ).toEqual([
        { side: "old", line: 1, range: [0, 10], tone: "current" },
        { side: "old", line: 1, range: [14, 24], tone: "match" },
        { side: "new", line: 1, range: [0, 10], tone: "match" },
        { side: "new", line: 1, range: [14, 24], tone: "match" },
      ]);
      expect(findTargets([repeated], query.locate)).toMatchObject([
        { count: 2, line: { matchRange: [0, 10], text: "readConfig(); readConfig();" } },
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

  test("gives the active target's quoted line the one current mark", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-0",
      hunkIndex: 0,
      lineOffset: 1,
    });

    expect(marks.map((mark) => mark.tone)).toEqual(["current", "match", "match"]);
  });

  test("a current target in another file marks nothing current here", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-1",
      hunkIndex: 0,
      lineOffset: 1,
    });

    expect(marks.every((mark) => mark.tone === "match")).toBe(true);
  });
});
