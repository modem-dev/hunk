import { describe, expect, test } from "bun:test";
import { createHistoryLaneCheckpoint, planHistoryPage } from "./lanePlanner";
import type { HistoryCommit } from "./types";

/** Build one deterministic history commit for graph tests. */
function commit(revisionId: string, parentRevisionIds: string[] = []): HistoryCommit {
  return {
    revisionId,
    displayId: revisionId,
    parentRevisionIds,
    subject: revisionId,
    authorName: "Test",
    authoredAt: "2026-01-01T00:00:00Z",
    decorations: [],
  };
}

describe("history lane planning", () => {
  test("preserves first-parent continuity and ordered merge parents", () => {
    const planned = planHistoryPage([
      commit("merge", ["main", "side"]),
      commit("side", ["base"]),
      commit("main", ["base"]),
      commit("base"),
    ]);

    expect(planned.rows.map((row) => [row.commit.revisionId, row.lane])).toEqual([
      ["merge", 0],
      ["side", 1],
      ["main", 0],
      ["base", 0],
    ]);
    expect(planned.checkpoint.lanes).toEqual([]);
  });

  test("draws the side branch converging into an already-active first parent", () => {
    const planned = planHistoryPage([
      commit("merge", ["main", "side"]),
      commit("side", ["main"]),
      commit("main"),
    ]);

    expect(planned.rows[1]!.convergences).toEqual([{ from: 1, to: 0 }]);
    expect(planned.checkpoint.lanes).toEqual([]);
  });

  test("uses explicit graph parents without changing review parents", () => {
    const filtered = { ...commit("match", ["omitted"]), graphParentRevisionIds: [] };
    const olderFiltered = {
      ...commit("older-match", ["another-omitted"]),
      graphParentRevisionIds: [],
    };
    const planned = planHistoryPage([filtered, olderFiltered]);

    expect(planned.rows.map((row) => row.lanesAfter)).toEqual([[], []]);
    expect(filtered.parentRevisionIds).toEqual(["omitted"]);
  });

  test("produces identical rows across every page partition", () => {
    const commits = [
      commit("merge", ["main", "side"]),
      commit("side", ["base"]),
      commit("main", ["base"]),
      commit("base"),
    ];
    const whole = planHistoryPage(commits);
    // Every bit chooses whether a page ends after that commit, covering all 2^(n-1) partitions.
    for (let boundaries = 0; boundaries < 1 << (commits.length - 1); boundaries += 1) {
      let checkpoint = createHistoryLaneCheckpoint();
      const rows = [];
      let start = 0;
      for (let index = 0; index < commits.length; index += 1) {
        if (index < commits.length - 1 && (boundaries & (1 << index)) === 0) continue;
        const page = planHistoryPage(commits.slice(start, index + 1), checkpoint);
        rows.push(...page.rows);
        checkpoint = page.checkpoint;
        start = index + 1;
      }
      expect(rows).toEqual(whole.rows);
      expect(checkpoint).toEqual(whole.checkpoint);
    }
  });

  test("rejects duplicate revisions within one page", () => {
    expect(() => planHistoryPage([commit("same"), commit("same")])).toThrow("duplicate revision");
  });
});
