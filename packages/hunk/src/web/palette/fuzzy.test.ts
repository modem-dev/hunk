import { describe, expect, test } from "bun:test";
import { fuzzyScore, rankFuzzy } from "./fuzzy";

describe("fuzzyScore", () => {
  test("matches a case-insensitive subsequence and nothing else", () => {
    expect(fuzzyScore("NH", "next hunk")).toBeNumber();
    expect(fuzzyScore("hn", "next")).toBeUndefined();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("prefers word starts and consecutive runs", () => {
    expect(fuzzyScore("main", "src/app/main.ts")!).toBeGreaterThan(
      fuzzyScore("main", "src/am/a/i/n.ts")!,
    );
  });
});

describe("rankFuzzy", () => {
  test("keeps input order with no query and drops non-matches with one", () => {
    const items = ["src/app/main.ts", "docs/readme.md", "src/gen/module-01.ts"];
    expect(rankFuzzy(items, "", (item) => [item])).toEqual(items);
    expect(rankFuzzy(items, "mod01", (item) => [item])).toEqual(["src/gen/module-01.ts"]);
  });
});
