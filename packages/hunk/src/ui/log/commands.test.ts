import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { LogSnapshot } from "./controller";
import { resolveCommandKeys } from "../lib/keymap";
import {
  buildHistoryCommands,
  buildHistoryHelpSections,
  historyCommand,
  historyCommandKeyDefaults,
  isHistoryCommandEnabled,
  type HistoryCommandHandlers,
  type HistoryCommandId,
} from "./commands";

const key = (name: string, sequence = name, ctrl = false, shift = false) =>
  ({ name, sequence, ctrl, shift }) as KeyEvent;

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
  selectionAnchor: null,
  top: 0,
  search: "",
  searchEditing: false,
  historyDone: true,
  loading: false,
  notice: "",
  presentation: {
    graph: true,
    unicode: true,
    author: true,
    date: true,
    decorations: true,
  },
});

const noopHandlers = Object.fromEntries(
  historyCommandKeyDefaults().map(({ id }) => [id, () => {}]),
) as unknown as HistoryCommandHandlers;

/** Return the first canonical command matched by one synthetic terminal key. */
function matchCommand(
  event: KeyEvent,
  userBindings?: Readonly<Record<string, string | readonly string[] | false>>,
) {
  const { keys } = resolveCommandKeys({
    defaults: historyCommandKeyDefaults(),
    userBindings,
  });
  return buildHistoryCommands({
    getSnapshot: snapshot,
    handlers: noopHandlers,
    resolvedKeys: keys,
  }).find((command) => command.match(event))?.id;
}

describe("history command authority", () => {
  test("drives keyboard dispatch, canonical menu identity, and help from resolved bindings", () => {
    expect(matchCommand(key("down", ""))).toBe("hunk.history.nextCommit");
    expect(matchCommand(key("down", "", false, true))).toBe("hunk.history.extendNext");
    expect(matchCommand(key("x", "J"))).toBe("hunk.history.extendNext");
    expect(matchCommand(key("up", "", false, true))).toBe("hunk.history.extendPrevious");
    expect(matchCommand(key("x", "K"))).toBe("hunk.history.extendPrevious");
    expect(matchCommand(key("x", "j"))).toBe("hunk.history.nextCommit");
    expect(matchCommand(key("c", "\x03", true))).toBe("hunk.app.quit");
    expect(matchCommand(key("t"))).toBe("hunk.view.openThemeSelector");
    expect(historyCommand("hunk.history.openFirstParent").title).toBe("Compare with first parent");

    const { keys } = resolveCommandKeys({
      defaults: historyCommandKeyDefaults(),
      userBindings: { "hunk.history.nextCommit": "ctrl+n" },
    });
    const commands = buildHistoryCommands({
      getSnapshot: snapshot,
      handlers: noopHandlers,
      resolvedKeys: keys,
    });
    const helpRows = buildHistoryHelpSections(commands).flatMap((section) => section.rows);
    expect(helpRows).toContainEqual({ keys: "Ctrl+N", description: "next commit" });
    expect(helpRows).toContainEqual({
      keys: "Shift+Up / K",
      description: "extend selection up",
    });
    expect(helpRows).toContainEqual({ keys: "t", description: "choose theme" });
  });

  test("remaps and unbinds history independently through the shared keymap", () => {
    expect(
      matchCommand(key("n", "", true), {
        "hunk.history.nextCommit": "ctrl+n",
        "hunk.history.previousCommit": false,
      }),
    ).toBe("hunk.history.nextCommit");
    expect(
      matchCommand(key("down", ""), {
        "hunk.history.nextCommit": "ctrl+n",
      }),
    ).toBeUndefined();
    expect(
      matchCommand(key("up", ""), {
        "hunk.history.previousCommit": false,
      }),
    ).toBeUndefined();
    expect(
      matchCommand(key("c", "\x03", true), {
        "hunk.history.nextCommit": "ctrl+c",
      }),
    ).toBe("hunk.history.nextCommit");
    expect(
      matchCommand(key("c", "\x03", true), {
        "hunk.app.quit": false,
      }),
    ).toBeUndefined();
  });

  test("derives parent and search enabled state from current snapshot", () => {
    const enabled = (id: HistoryCommandId, value = snapshot()) =>
      isHistoryCommandEnabled(id, value);
    expect(enabled("hunk.history.openFirstParent")).toBe(false);
    expect(enabled("hunk.history.openFirstParent", snapshot(["p1", "p2"]))).toBe(true);
    expect(enabled("hunk.history.openParent", snapshot(["p1", "p2"]))).toBe(true);
    const range = { ...snapshot(["p1", "p2"]), selectionAnchor: 1 };
    expect(enabled("hunk.history.openFirstParent", range)).toBe(false);
    expect(enabled("hunk.history.openParent", range)).toBe(false);
    expect(enabled("hunk.history.nextMatch")).toBe(false);
  });
});
