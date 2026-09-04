import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { LogSnapshot } from "./controller";
import {
  buildLogHelpSections,
  isLogCommandEnabled,
  logCommand,
  logCommandHint,
  matchLogCommand,
} from "./commands";

const key = (name: string, sequence = name, ctrl = false) => ({ name, sequence, ctrl }) as KeyEvent;

const snapshot = (parents: string[] = []): LogSnapshot => ({
  rows: [
    {
      commit: {
        revisionId: "commit",
        displayId: "commit",
        parentRevisionIds: parents,
        subject: "subject",
        authorName: "Ada",
        authoredAt: "2026-01-01T00:00:00Z",
        decorations: [],
      },
      lane: 0,
      lanesBefore: [],
      lanesAfter: [],
      cells: [],
      parentLanes: [],
      convergences: [],
    },
  ],
  selected: 0,
  top: 0,
  search: "",
  searchEditing: false,
  historyDone: true,
  loading: false,
  notice: "",
  presentation: {
    format: "compact",
    graph: true,
    unicode: true,
    author: true,
    date: true,
    decorations: true,
  },
});

describe("log command authority", () => {
  test("drives keyboard dispatch, menu hints, and help from one definition", () => {
    expect(matchLogCommand(key("down", ""))).toBe("next");
    expect(matchLogCommand(key("x", "j"))).toBe("next");
    expect(matchLogCommand(key("c", "\x03", true))).toBe("quit");
    expect(logCommandHint("next")).toBe("↓ / j");
    expect(logCommand("open-first-parent").label).toBe("Compare with first parent");
    expect(logCommand("open-parent").label).toBe("Compare with parent…");
    expect(buildLogHelpSections().flatMap((section) => section.rows)).toContainEqual({
      keys: "↓ / j",
      description: "next commit",
    });
  });

  test("derives parent and search enabled state from current snapshot", () => {
    expect(isLogCommandEnabled("open-first-parent", snapshot())).toBe(false);
    expect(isLogCommandEnabled("open-first-parent", snapshot(["p1", "p2"]))).toBe(true);
    expect(isLogCommandEnabled("open-parent", snapshot(["p1", "p2"]))).toBe(true);
    expect(isLogCommandEnabled("next-match", snapshot())).toBe(false);
  });
});
