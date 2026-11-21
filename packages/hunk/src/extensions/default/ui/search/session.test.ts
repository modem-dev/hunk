import { describe, expect, test } from "bun:test";
import {
  createTestSearchFile,
  searchTestAlpha as alpha,
  searchTestBeta as beta,
  searchTestBlock as block,
  searchTestRepeated as repeated,
} from "../../../../../../../test/helpers/search-fixtures";
import type { SearchLayout } from "./search";
import {
  createSearchSession,
  formatOutcomeSpans,
  type SearchOutcome,
  type SearchPosition,
  type SearchSession,
} from "./session";

const nowhere: SearchPosition = { fileId: null, hunkIndex: null, currentLine: null };
const at = (fileId: string, hunkIndex: number): SearchPosition => ({
  fileId,
  hunkIndex,
  currentLine: null,
});

/** Name the occurrence an outcome landed on, `side:line@start`. */
function landing(outcome: SearchOutcome) {
  if (outcome.kind !== "moved") return outcome.kind;
  const { side, lineNumber, matchRange } = outcome.target.line;
  return `${side}:${lineNumber}@${matchRange[0]}`;
}

/** Step `count` times from wherever the session last landed, in one hunk of `block`. */
function walkBlock(
  session: SearchSession,
  direction: "forward" | "backward",
  count: number,
  layout: SearchLayout = "unified",
) {
  const landings: string[] = [];
  for (let step = 0; step < count; step += 1) {
    landings.push(landing(session.repeat(direction, blockFiles, at("file-block", 0), layout)));
  }
  return landings;
}
const files = [alpha, beta];
const blockFiles = [block];
const blockAndBeta = [block, beta];
const repeatedFiles = [repeated];

describe("search session", () => {
  test("a fresh search jumps forward from the current position", () => {
    const session = createSearchSession({ mode: "literal" });

    const outcome = session.search("readConfig", files, at("file-0", 0), "unified");

    expect(outcome).toMatchObject({ kind: "moved", index: 1, total: 4, wrapped: false });
    expect(outcome.kind === "moved" && outcome.target.path).toBe("src/alpha.ts");
  });

  test("a fresh search includes the cursor line, while a repeat from it is strict", () => {
    const cursor: SearchPosition = {
      fileId: "file-block",
      hunkIndex: 0,
      currentLine: { side: "old", line: 2 },
    };
    const session = createSearchSession({ mode: "literal" });

    expect(landing(session.search("foo", blockFiles, cursor, "unified"))).toBe("old:2@4");
    // A new array identity orphans `current`, so the repeat positions from the cursor line.
    expect(landing(session.repeat("forward", [block], cursor, "unified"))).toBe("old:3@4");
  });

  test("a fresh search includes the selected hunk, while a repeat skips past it", () => {
    const session = createSearchSession({ mode: "literal" });

    const fresh = session.search("readConfig", files, at("file-0", 0), "unified");
    expect(fresh.kind === "moved" && fresh.target.path).toBe("src/alpha.ts");

    const repeat = session.repeat("forward", [...files], at("file-0", 0), "unified");
    expect(repeat.kind === "moved" && repeat.target.path).toBe("src/beta.ts");
  });

  test("n and N walk the same list in both directions", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");

    expect(session.repeat("forward", files, at("file-0", 0), "unified")).toMatchObject({
      index: 2,
    });
    expect(session.repeat("backward", files, at("file-1", 0), "unified")).toMatchObject({
      index: 3,
    });
  });

  test("repeats wrap strictly so the only match comes back around", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", [beta], nowhere, "unified");

    // Already on the one matching hunk: a strict forward step runs off the end
    // and wraps to the same hunk rather than answering "no movement".
    expect(session.repeat("forward", [beta], at("file-1", 0), "unified")).toMatchObject({
      kind: "moved",
      index: 1,
      total: 1,
      wrapped: true,
    });
  });

  test("repeats follow the live selection, not the last landing", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");
    expect(session.repeat("forward", files, at("file-0", 0), "unified")).toMatchObject({
      index: 2,
    });

    // From the landing (alpha's new:11) `n` would stay in the first hunk; the user moved
    // to alpha's second hunk by hand, so `n` steps from there to beta without wrapping.
    expect(session.repeat("forward", files, at("file-0", 1), "unified")).toMatchObject({
      index: 4,
      wrapped: false,
    });
    expect(session.repeat("forward", files, at("file-1", 0), "unified")).toMatchObject({
      index: 1,
      wrapped: true,
    });
  });

  test("n walks every occurrence in a hunk before the next hunk, and N reverses", () => {
    const session = createSearchSession({ mode: "literal" });
    const landings = [landing(session.search("foo", blockAndBeta, nowhere, "unified"))];
    for (let press = 0; press < 5; press += 1) {
      landings.push(
        landing(session.repeat("forward", blockAndBeta, at("file-block", 0), "unified")),
      );
    }

    expect(landings).toEqual(["new:1@4", "old:2@4", "old:3@4", "new:2@4", "new:3@4", "new:3@12"]);
    const reversed = [1, 2, 3].map(() =>
      landing(session.repeat("backward", blockAndBeta, at("file-block", 0), "unified")),
    );
    expect(reversed).toEqual(["new:3@4", "new:2@4", "old:3@4"]);
  });

  test("a hunk with several occurrences no longer wraps onto itself", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("foo", blockFiles, nowhere, "unified");

    expect(session.repeat("forward", blockFiles, at("file-block", 0), "unified")).toMatchObject({
      index: 2,
      total: 6,
      wrapped: false,
    });
  });

  test("a layout switch re-sorts the targets and keeps the current occurrence", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("foo", blockFiles, nowhere, "unified");
    expect(walkBlock(session, "forward", 2)).toEqual(["old:2@4", "old:3@4"]);

    // Unified would continue to new:2; split pairs old:3 with new:3 on one row.
    expect(landing(session.repeat("forward", blockFiles, at("file-block", 0), "split"))).toBe(
      "new:3@4",
    );
    expect(session.marksFor(block)?.filter((mark) => mark.tone === "current")).toEqual([
      { side: "new", line: 3, range: [4, 7], tone: "current" },
    ]);
  });

  test("without a current target, stepping starts from the cursor line in layout order", () => {
    const cursor: SearchPosition = {
      fileId: "file-block",
      hunkIndex: 0,
      currentLine: { side: "old", line: 2 },
    };

    const repeatFromCursor = (direction: "forward" | "backward", layout: SearchLayout) => {
      const session = createSearchSession({ mode: "literal" });
      session.search("foo", blockFiles, nowhere, layout);
      return landing(session.repeat(direction, blockFiles, cursor, layout));
    };
    const forward = (layout: SearchLayout) => repeatFromCursor("forward", layout);
    const backward = (layout: SearchLayout) => repeatFromCursor("backward", layout);

    expect(forward("unified")).toBe("old:3@4");
    expect(forward("split")).toBe("new:2@4");
    expect(backward("unified")).toBe("new:1@4");
    expect(backward("split")).toBe("new:1@4");
    expect(
      landing(createSearchSession({ mode: "literal" }).search("foo", blockFiles, cursor, "split")),
    ).toBe("old:2@4");
  });

  test.each(["literal", "regex"] as const)(
    "%s keeps trailing whitespace for prompt prefill, marks, and corpus rebuilds",
    (mode) => {
      const session = createSearchSession({ mode });
      const file = createTestSearchFile("whitespace", "spaces.ts", "@@ -0,0 +1 @@\n+foo fooX");
      const replacement = createTestSearchFile("whitespace", "spaces.ts", "@@ -0,0 +1 @@\n+fooX");

      expect(session.search("foo ", [file], nowhere, "unified")).toMatchObject({
        kind: "moved",
        total: 1,
      });
      expect(session.query).toBe("foo ");
      expect(session.marksFor(file)).toEqual([
        { side: "new", line: 1, range: [0, 4], tone: "current" },
      ]);
      expect(session.repeat("forward", [replacement], nowhere, "unified")).toEqual({
        kind: "no-matches",
        query: "foo ",
      });
      expect(session.query).toBe("foo ");
      expect(session.marksFor(replacement)).toEqual([]);
    },
  );

  test("a query with no matches reports itself instead of moving", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.search("nowhere", files, nowhere, "unified")).toEqual({
      kind: "no-matches",
      query: "nowhere",
    });
  });

  test("repeating before any search says so", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.repeat("forward", files, nowhere, "unified")).toEqual({ kind: "no-query" });
  });

  test("an invalid query leaves the previous one repeatable", () => {
    const session = createSearchSession({ mode: "regex" });
    session.search("readConfig", files, nowhere, "unified");

    expect(session.search("read(", files, nowhere, "unified").kind).toBe("invalid-query");
    expect(session.query).toBe("readConfig");
    expect(session.repeat("forward", files, nowhere, "unified")).toMatchObject({ kind: "moved" });
  });

  test("an empty query is refused as invalid rather than clearing anything", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");

    expect(session.search("   ", files, nowhere, "unified")).toMatchObject({
      kind: "invalid-query",
    });
    expect(session.query).toBe("readConfig");
  });

  test("clear forgets the query, its marks, and its targets", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");

    session.clear();

    expect(session.query).toBeNull();
    expect(session.total).toBe(0);
    expect(session.marksFor(alpha)).toBeNull();
    expect(session.repeat("forward", files, nowhere, "unified")).toEqual({ kind: "no-query" });
  });

  test("a changed corpus re-matches the live query against the new files", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");
    expect(session.total).toBe(4);

    // The filter hid alpha, or a reload replaced the files: the next repeat
    // sees only what is visible now.
    expect(session.repeat("forward", [beta], nowhere, "unified")).toMatchObject({
      kind: "moved",
      index: 1,
      total: 1,
    });
    expect(session.total).toBe(1);
  });

  test("hidden files never become targets", () => {
    const session = createSearchSession({ mode: "literal" });

    const outcome = session.search("readConfig", [beta], at("file-1", 0), "unified");

    expect(outcome).toMatchObject({ kind: "moved", index: 1, total: 1, wrapped: false });
    expect(session.marksFor(alpha)?.map((mark) => mark.tone)).toEqual(["match", "match", "match"]);
  });
});

describe("session marks", () => {
  test("paints nothing before the first search and marks after it", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.marksFor(alpha)).toBeNull();

    session.search("readConfig", files, nowhere, "unified");

    const alphaMarks = session.marksFor(alpha);
    expect(alphaMarks?.map((mark) => mark.tone)).toEqual(["current", "match", "match"]);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["match"]);
  });

  test.each(["literal", "regex"] as const)(
    "%s marks every occurrence and moves current to the second range on a repeat",
    (mode) => {
      const session = createSearchSession({ mode });
      const outcome = session.search("readConfig", repeatedFiles, nowhere, "unified");

      expect(session.total).toBe(4);
      expect(session.marksFor(repeated)).toEqual([
        { side: "old", line: 1, range: [0, 10], tone: "current" },
        { side: "old", line: 1, range: [14, 24], tone: "match" },
        { side: "new", line: 1, range: [0, 10], tone: "match" },
        { side: "new", line: 1, range: [14, 24], tone: "match" },
      ]);
      expect(formatOutcomeSpans(outcome)).toEqual([
        { text: "[1/4] ", tone: "accent" },
        { text: "src/repeated.ts:1", tone: "muted" },
        { text: " — readConfig(); readConfig();" },
      ]);

      session.repeat("forward", repeatedFiles, at("file-repeated", 0), "unified");
      expect(session.marksFor(repeated)?.map((mark) => mark.tone)).toEqual([
        "match",
        "current",
        "match",
        "match",
      ]);
    },
  );

  test("the current mark follows n across files", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");

    // Alpha's hunk holds three occurrences: two more presses stay in it, the third crosses.
    for (let press = 0; press < 3; press += 1) {
      session.repeat("forward", files, at("file-0", 0), "unified");
    }

    expect(session.marksFor(alpha)?.every((mark) => mark.tone === "match")).toBe(true);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["current"]);
  });

  test("a rebuilt corpus keeps the query but drops the orphaned current mark", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");
    expect(session.marksFor(alpha)?.[0]?.tone).toBe("current");

    // Same content, new identity — what a reload hands the next command. The
    // old current target belongs to file objects that no longer exist.
    session.repeat("forward", [...files], at("file-1", 0), "unified");

    expect(session.query).toBe("readConfig");
    expect(session.marksFor(alpha)?.map((mark) => mark.tone)).toEqual([
      "current",
      "match",
      "match",
    ]);
  });
});

describe("formatOutcomeSpans", () => {
  test("a match reads like a less status line", () => {
    const session = createSearchSession({ mode: "literal" });

    const outcome = session.search("readConfig", files, nowhere, "unified");

    expect(formatOutcomeSpans(outcome)).toEqual([
      { text: "[1/4] ", tone: "accent" },
      { text: "src/alpha.ts:11", tone: "muted" },
      { text: " — const removed = readConfig();" },
    ]);
  });

  test("a wrap and a miss are both said out loud", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere, "unified");

    const wrapped = formatOutcomeSpans(
      session.repeat("forward", files, at("file-1", 0), "unified"),
    );
    expect(wrapped.map((span) => span.text).join("")).toContain("• wrapped");
    expect(formatOutcomeSpans({ kind: "no-matches", query: "zzz" })).toEqual([
      { text: 'No match for "zzz"', tone: "removed" },
    ]);
    expect(formatOutcomeSpans({ kind: "no-query" })[0]?.text).toBe(
      "No search yet — press / to search",
    );
    expect(formatOutcomeSpans({ kind: "invalid-query", query: "(", error: "bad" })[0]?.text).toBe(
      'Bad search "(" • bad',
    );
  });
});
