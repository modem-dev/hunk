import { describe, expect, test } from "bun:test";
import type { ReviewSidebarEntry } from "../../core/review/fileLabels";
import type { ReviewViewedStatus } from "../viewed/viewedFiles";
import {
  directoryViewedRollups,
  formatNoteCountLabel,
  formatViewedRollup,
  headingViewedRollups,
  showsViewedRollup,
} from "./viewedRollup";

const statuses = new Map<string, ReviewViewedStatus>([
  ["a", "viewed"],
  ["b", "changed"],
  ["d", "viewed"],
]);

describe("directoryViewedRollups", () => {
  test("counts every file at or below each directory, viewed marks only", () => {
    const rollups = directoryViewedRollups(
      [
        { key: "a", path: "src/app/main.ts" },
        { key: "b", path: "src/app/util.ts" },
        { key: "c", path: "src/gen/x.ts" },
        { key: "d", path: "README.md" },
      ],
      statuses,
    );
    expect(Object.fromEntries(rollups)).toEqual({
      src: { viewed: 1, total: 3 },
      "src/app": { viewed: 1, total: 2 },
      "src/gen": { viewed: 0, total: 1 },
    });
  });

  test("counts nothing as viewed without statuses", () => {
    expect(directoryViewedRollups([{ key: "a", path: "src/a.ts" }], undefined).get("src")).toEqual({
      viewed: 0,
      total: 1,
    });
  });
});

describe("headingViewedRollups", () => {
  test("counts the run of files under each heading, a repeated directory separately", () => {
    const file = (id: string) => ({ kind: "file", id }) as ReviewSidebarEntry;
    const rows: ReviewSidebarEntry[] = [
      { kind: "group", id: "group:src:0", label: "src/" },
      file("a"),
      file("b"),
      { kind: "group", id: "group:docs:2", label: "docs/" },
      file("c"),
      { kind: "group", id: "group:src:3", label: "src/" },
      file("d"),
    ];
    expect(Object.fromEntries(headingViewedRollups(rows, statuses))).toEqual({
      "group:src:0": { viewed: 1, total: 2 },
      "group:docs:2": { viewed: 0, total: 1 },
      "group:src:3": { viewed: 1, total: 1 },
    });
  });
});

describe("showsViewedRollup", () => {
  test("keeps small folders quiet until one file is viewed", () => {
    expect(showsViewedRollup(undefined)).toBe(false);
    expect(showsViewedRollup({ viewed: 0, total: 5 })).toBe(false);
    expect(showsViewedRollup({ viewed: 1, total: 2 })).toBe(true);
    expect(showsViewedRollup({ viewed: 0, total: 6 })).toBe(true);
  });
});

describe("formatViewedRollup", () => {
  test("prints the count with grouped digits and names it", () => {
    expect(formatViewedRollup({ viewed: 1, total: 2000 })).toEqual({
      text: "1/2,000",
      label: "1 of 2,000 files viewed",
      complete: false,
    });
    expect(formatViewedRollup({ viewed: 3, total: 3 }).complete).toBe(true);
  });
});

describe("formatNoteCountLabel", () => {
  test("names the count in words", () => {
    expect(formatNoteCountLabel(1)).toBe("1 note");
    expect(formatNoteCountLabel(1200)).toBe("1,200 notes");
  });
});
