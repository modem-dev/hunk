import { describe, expect, test } from "bun:test";
import {
  searchTestAlpha as alpha,
  searchTestBeta as beta,
} from "../../../../../../../test/helpers/search-fixtures";
import { createSearchSession, formatOutcomeSpans } from "./session";

const nowhere = { fileId: null, hunkIndex: null };
const files = [alpha, beta];

describe("search session", () => {
  test("a fresh search jumps forward from the current position", () => {
    const session = createSearchSession({ mode: "literal" });

    const outcome = session.search("readConfig", files, { fileId: "file-0", hunkIndex: 0 });

    expect(outcome).toMatchObject({ kind: "moved", index: 2, total: 2, wrapped: false });
    expect(outcome.kind === "moved" && outcome.target.path).toBe("src/beta.ts");
  });

  test("n and N walk the same list in both directions", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);

    expect(session.repeat("forward", files, { fileId: "file-0", hunkIndex: 0 })).toMatchObject({
      index: 2,
    });
    expect(session.repeat("backward", files, { fileId: "file-1", hunkIndex: 0 })).toMatchObject({
      index: 1,
    });
  });

  test("repeats wrap strictly so the only match comes back around", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", [beta], nowhere);

    // Already on the one matching hunk: a strict forward step runs off the end
    // and wraps to the same hunk rather than answering "no movement".
    expect(session.repeat("forward", [beta], { fileId: "file-1", hunkIndex: 0 })).toMatchObject({
      kind: "moved",
      index: 1,
      total: 1,
      wrapped: true,
    });
  });

  test("repeats follow the live selection, not the last landing", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);
    expect(session.repeat("forward", files, { fileId: "file-0", hunkIndex: 0 })).toMatchObject({
      index: 2,
    });

    // From the landing (beta) another `n` would wrap; the user moved back to
    // alpha's second hunk by hand, so `n` steps from there and does not wrap.
    expect(session.repeat("forward", files, { fileId: "file-0", hunkIndex: 1 })).toMatchObject({
      index: 2,
      wrapped: false,
    });
    expect(session.repeat("forward", files, { fileId: "file-1", hunkIndex: 0 })).toMatchObject({
      index: 1,
      wrapped: true,
    });
  });

  test("a query with no matches reports itself instead of moving", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.search("nowhere", files, nowhere)).toEqual({
      kind: "no-matches",
      query: "nowhere",
    });
  });

  test("repeating before any search says so", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.repeat("forward", files, nowhere)).toEqual({ kind: "no-query" });
  });

  test("an invalid query leaves the previous one repeatable", () => {
    const session = createSearchSession({ mode: "regex" });
    session.search("readConfig", files, nowhere);

    expect(session.search("read(", files, nowhere).kind).toBe("invalid-query");
    expect(session.query).toBe("readConfig");
    expect(session.repeat("forward", files, nowhere)).toMatchObject({ kind: "moved" });
  });

  test("an empty query is refused as invalid rather than clearing anything", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);

    expect(session.search("   ", files, nowhere)).toMatchObject({ kind: "invalid-query" });
    expect(session.query).toBe("readConfig");
  });

  test("clear forgets the query, its marks, and its targets", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);

    session.clear();

    expect(session.query).toBeNull();
    expect(session.total).toBe(0);
    expect(session.marksFor(alpha)).toBeNull();
    expect(session.repeat("forward", files, nowhere)).toEqual({ kind: "no-query" });
  });

  test("a changed corpus re-matches the live query against the new files", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);
    expect(session.total).toBe(2);

    // The filter hid alpha, or a reload replaced the files: the next repeat
    // sees only what is visible now.
    expect(session.repeat("forward", [beta], nowhere)).toMatchObject({
      kind: "moved",
      index: 1,
      total: 1,
    });
    expect(session.total).toBe(1);
  });

  test("hidden files never become targets", () => {
    const session = createSearchSession({ mode: "literal" });

    const outcome = session.search("readConfig", [beta], { fileId: "file-1", hunkIndex: 0 });

    expect(outcome).toMatchObject({ kind: "moved", index: 1, total: 1, wrapped: true });
    expect(session.marksFor(alpha)?.map((mark) => mark.tone)).toEqual(["match", "match", "match"]);
  });
});

describe("session marks", () => {
  test("paints nothing before the first search and marks after it", () => {
    const session = createSearchSession({ mode: "literal" });

    expect(session.marksFor(alpha)).toBeNull();

    session.search("readConfig", files, nowhere);

    const alphaMarks = session.marksFor(alpha);
    expect(alphaMarks?.map((mark) => mark.tone)).toEqual(["current", "match", "match"]);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["match"]);
  });

  test("the current mark follows n across files", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);

    session.repeat("forward", files, { fileId: "file-0", hunkIndex: 0 });

    expect(session.marksFor(alpha)?.every((mark) => mark.tone === "match")).toBe(true);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["current"]);
  });

  test("a rebuilt corpus keeps the query but drops the orphaned current mark", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);
    expect(session.marksFor(alpha)?.[0]?.tone).toBe("current");

    // Same content, new identity — what a reload hands the next command. The
    // old current target belongs to file objects that no longer exist.
    session.repeat("forward", [...files], { fileId: "file-1", hunkIndex: 0 });

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

    const outcome = session.search("readConfig", files, nowhere);

    expect(formatOutcomeSpans(outcome)).toEqual([
      { text: "[1/2] ", tone: "accent" },
      { text: "src/alpha.ts:11 (+2 in hunk)", tone: "muted" },
      { text: " — const removed = readConfig();" },
    ]);
  });

  test("a wrap and a miss are both said out loud", () => {
    const session = createSearchSession({ mode: "literal" });
    session.search("readConfig", files, nowhere);

    const wrapped = formatOutcomeSpans(
      session.repeat("forward", files, { fileId: "file-1", hunkIndex: 0 }),
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
