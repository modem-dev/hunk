import { describe, expect, test } from "bun:test";
import { planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryCommit } from "../../core/history/types";
import { planLogViewportGeometry } from "./geometry";

/** Build one deterministic commit for day-group viewport tests. */
function commit(id: string, authoredAt: string): HistoryCommit {
  return {
    revisionId: id.repeat(40),
    displayId: id.repeat(8),
    parentRevisionIds: [],
    subject: id,
    authorName: "Test Author",
    authorEmail: "tester@example.com",
    authoredAt,
    decorations: [],
  };
}

const rows = planHistoryPage([
  commit("a", new Date(2026, 8, 6, 12).toISOString()),
  commit("b", new Date(2026, 8, 6, 11).toISOString()),
  commit("c", new Date(2026, 8, 5, 12).toISOString()),
  commit("d", new Date(2026, 8, 5, 11).toISOString()),
]).rows;

describe("log viewport geometry", () => {
  test("accounts for one heading per visible day and never exceeds the body", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 0,
      requestedTop: 0,
      bodyHeight: 13,
      groupByDay: true,
    });
    expect(geometry.entries.map((entry) => [entry.index, entry.showDayHeader])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
    expect(geometry.usedHeight).toBe(13);
  });

  test("repeats the current day heading while backfilling near EOF", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 3,
      requestedTop: 3,
      bodyHeight: 8,
      groupByDay: true,
    });
    expect(geometry.top).toBe(2);
    expect(geometry.entries[0]).toMatchObject({ index: 2, showDayHeader: true });
  });

  test("omits day headings in graph view", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 0,
      requestedTop: 0,
      bodyHeight: 9,
      groupByDay: false,
    });
    expect(geometry.entries.map((entry) => [entry.index, entry.showDayHeader])).toEqual([
      [0, false],
      [1, false],
      [2, false],
    ]);
    expect(geometry.usedHeight).toBe(9);
  });

  test("bounds planning work when jumping deep into a large history", () => {
    let indexedReads = 0;
    const manyRows = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => rows[index % rows.length]!),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const geometry = planLogViewportGeometry({
      rows: manyRows,
      selected: 9_999,
      requestedTop: 0,
      bodyHeight: 17,
      groupByDay: false,
    });
    expect(geometry.top).toBe(9_995);
    expect(geometry.entries).toHaveLength(5);
    expect(indexedReads).toBeLessThan(100);
  });

  test("advances the commit-index top until the selection fits", () => {
    const geometry = planLogViewportGeometry({
      rows,
      selected: 2,
      requestedTop: 0,
      bodyHeight: 10,
      groupByDay: true,
    });
    expect(geometry.top).toBe(1);
    expect(geometry.entries.at(-1)?.index).toBe(2);
    expect(geometry.usedHeight).toBeLessThanOrEqual(10);
  });
});
