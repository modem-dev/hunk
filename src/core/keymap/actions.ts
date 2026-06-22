export type ActionScope = "global" | "pager" | "menu" | "filter";

/**
 * Per-scope action id unions. Splitting `ActionId` by scope lets the
 * `Keymap` type and `matchesAction`/`findActionForKey` reject mismatched
 * (scope, id) pairs at compile time — `keymap.global["menu.close"]` is now a
 * type error instead of a silent `undefined`.
 */
export type GlobalActionId =
  | "quit"
  | "help.toggle"
  | "filter.focus"
  | "focus.toggle"
  | "scroll.pageDown"
  | "scroll.pageUp"
  | "scroll.halfPageDown"
  | "scroll.halfPageUp"
  | "scroll.lineDown"
  | "scroll.lineUp"
  | "scroll.toTop"
  | "scroll.toBottom"
  | "scroll.codeLeft"
  | "scroll.codeRight"
  | "scroll.codeLeftFast"
  | "scroll.codeRightFast"
  | "layout.split"
  | "layout.stack"
  | "layout.auto"
  | "sidebar.toggle"
  | "reload"
  | "theme.cycle"
  | "agentNotes.toggle"
  | "lineNumbers.toggle"
  | "wrap.toggle"
  | "hunkHeaders.toggle"
  | "hunk.prev"
  | "hunk.next"
  | "hunk.toggleGap"
  | "annotatedHunk.prev"
  | "annotatedHunk.next"
  | "file.prev"
  | "file.next"
  | "file.edit"
  | "menu.open";

export type PagerActionId =
  | "quit"
  | "scroll.pageDown"
  | "scroll.pageUp"
  | "scroll.halfPageDown"
  | "scroll.halfPageUp"
  | "scroll.lineDown"
  | "scroll.lineUp"
  | "scroll.toTop"
  | "scroll.toBottom"
  | "scroll.codeLeft"
  | "scroll.codeRight"
  | "scroll.codeLeftFast"
  | "scroll.codeRightFast"
  | "wrap.toggle"
  | "sidebar.toggle";

export type MenuActionId =
  | "menu.close"
  | "menu.prev"
  | "menu.next"
  | "menu.itemUp"
  | "menu.itemDown"
  | "menu.activate";

export type FilterActionId = "focus.toggle";

/** Map a scope to its specific action id union. */
export type ActionIdForScope<S extends ActionScope> = S extends "global"
  ? GlobalActionId
  : S extends "pager"
    ? PagerActionId
    : S extends "menu"
      ? MenuActionId
      : S extends "filter"
        ? FilterActionId
        : never;

/** Union of every legal action id across all scopes. */
export type ActionId = GlobalActionId | PagerActionId | MenuActionId | FilterActionId;

export interface ActionDef {
  id: ActionId;
  scope: ActionScope;
  defaultKeys: string[];
  description: string;
  group: string;
}

/**
 * Full action registry. Order within the array drives help-dialog grouping
 * order; `group` drives section labels.
 */
export const ACTIONS: readonly ActionDef[] = [
  // ---------- global: navigation ----------
  {
    id: "scroll.lineDown",
    scope: "global",
    defaultKeys: ["j", "<down>"],
    description: "move line-by-line (down)",
    group: "Navigation",
  },
  {
    id: "scroll.lineUp",
    scope: "global",
    defaultKeys: ["k", "<up>"],
    description: "move line-by-line (up)",
    group: "Navigation",
  },
  {
    id: "scroll.pageDown",
    scope: "global",
    defaultKeys: ["<space>", "f", "<pgdown>"],
    description: "page down",
    group: "Navigation",
  },
  {
    id: "scroll.pageUp",
    scope: "global",
    defaultKeys: ["b", "<pgup>", "<s-space>"],
    description: "page up",
    group: "Navigation",
  },
  {
    id: "scroll.halfPageDown",
    scope: "global",
    defaultKeys: ["d"],
    description: "half page down",
    group: "Navigation",
  },
  {
    id: "scroll.halfPageUp",
    scope: "global",
    defaultKeys: ["u"],
    description: "half page up",
    group: "Navigation",
  },
  {
    id: "scroll.toTop",
    scope: "global",
    defaultKeys: ["g", "<home>"],
    description: "jump to top",
    group: "Navigation",
  },
  {
    id: "scroll.toBottom",
    scope: "global",
    defaultKeys: ["G", "<end>"],
    description: "jump to bottom",
    group: "Navigation",
  },
  {
    id: "scroll.codeLeft",
    scope: "global",
    defaultKeys: ["<left>"],
    description: "scroll code left",
    group: "Navigation",
  },
  {
    id: "scroll.codeRight",
    scope: "global",
    defaultKeys: ["<right>"],
    description: "scroll code right",
    group: "Navigation",
  },
  {
    id: "scroll.codeLeftFast",
    scope: "global",
    defaultKeys: ["<s-left>"],
    description: "scroll code left (fast)",
    group: "Navigation",
  },
  {
    id: "scroll.codeRightFast",
    scope: "global",
    defaultKeys: ["<s-right>"],
    description: "scroll code right (fast)",
    group: "Navigation",
  },
  {
    id: "hunk.prev",
    scope: "global",
    defaultKeys: ["["],
    description: "previous hunk",
    group: "Review",
  },
  {
    id: "hunk.next",
    scope: "global",
    defaultKeys: ["]"],
    description: "next hunk",
    group: "Review",
  },
  {
    id: "annotatedHunk.prev",
    scope: "global",
    defaultKeys: ["{"],
    description: "previous comment",
    group: "Review",
  },
  {
    id: "annotatedHunk.next",
    scope: "global",
    defaultKeys: ["}"],
    description: "next comment",
    group: "Review",
  },
  {
    id: "file.prev",
    scope: "global",
    defaultKeys: [","],
    description: "previous file",
    group: "Review",
  },
  {
    id: "file.next",
    scope: "global",
    defaultKeys: ["."],
    description: "next file",
    group: "Review",
  },
  {
    id: "hunk.toggleGap",
    scope: "global",
    defaultKeys: ["z"],
    description: "toggle context gap for the selected hunk",
    group: "Review",
  },
  {
    id: "file.edit",
    scope: "global",
    defaultKeys: ["e"],
    description: "edit selected file in $EDITOR",
    group: "Review",
  },
  // ---------- global: view ----------
  {
    id: "layout.split",
    scope: "global",
    defaultKeys: ["1"],
    description: "split layout",
    group: "View",
  },
  {
    id: "layout.stack",
    scope: "global",
    defaultKeys: ["2"],
    description: "stack layout",
    group: "View",
  },
  {
    id: "layout.auto",
    scope: "global",
    defaultKeys: ["0"],
    description: "auto layout",
    group: "View",
  },
  {
    id: "sidebar.toggle",
    scope: "global",
    defaultKeys: ["s"],
    description: "toggle sidebar",
    group: "View",
  },
  {
    id: "theme.cycle",
    scope: "global",
    defaultKeys: ["t"],
    description: "cycle theme",
    group: "View",
  },
  {
    id: "agentNotes.toggle",
    scope: "global",
    defaultKeys: ["a"],
    description: "toggle agent notes",
    group: "View",
  },
  {
    id: "lineNumbers.toggle",
    scope: "global",
    defaultKeys: ["l"],
    description: "toggle line numbers",
    group: "View",
  },
  {
    id: "wrap.toggle",
    scope: "global",
    defaultKeys: ["w"],
    description: "toggle line wrap",
    group: "View",
  },
  {
    id: "hunkHeaders.toggle",
    scope: "global",
    defaultKeys: ["m"],
    description: "toggle hunk metadata headers",
    group: "View",
  },
  // ---------- global: app ----------
  {
    id: "quit",
    scope: "global",
    defaultKeys: ["q", "<esc>"],
    description: "quit",
    group: "App",
  },
  {
    id: "help.toggle",
    scope: "global",
    defaultKeys: ["?"],
    description: "toggle help",
    group: "App",
  },
  {
    id: "filter.focus",
    scope: "global",
    defaultKeys: ["/"],
    description: "focus file filter",
    group: "App",
  },
  {
    id: "focus.toggle",
    scope: "global",
    defaultKeys: ["<tab>"],
    description: "toggle files/filter focus",
    group: "App",
  },
  {
    id: "reload",
    scope: "global",
    defaultKeys: ["r"],
    description: "reload current input",
    group: "App",
  },
  {
    id: "menu.open",
    scope: "global",
    defaultKeys: ["<f10>"],
    description: "open menus",
    group: "App",
  },

  // ---------- pager scope ----------
  {
    id: "quit",
    scope: "pager",
    defaultKeys: ["q", "<esc>"],
    description: "quit",
    group: "Pager",
  },
  {
    id: "scroll.lineDown",
    scope: "pager",
    defaultKeys: ["j", "<down>"],
    description: "scroll one line down",
    group: "Pager",
  },
  {
    id: "scroll.lineUp",
    scope: "pager",
    defaultKeys: ["k", "<up>"],
    description: "scroll one line up",
    group: "Pager",
  },
  {
    id: "scroll.pageDown",
    scope: "pager",
    defaultKeys: ["<space>", "f", "<pgdown>"],
    description: "page down",
    group: "Pager",
  },
  {
    id: "scroll.pageUp",
    scope: "pager",
    defaultKeys: ["b", "<pgup>", "<s-space>"],
    description: "page up",
    group: "Pager",
  },
  {
    id: "scroll.halfPageDown",
    scope: "pager",
    defaultKeys: ["d"],
    description: "half page down",
    group: "Pager",
  },
  {
    id: "scroll.halfPageUp",
    scope: "pager",
    defaultKeys: ["u"],
    description: "half page up",
    group: "Pager",
  },
  {
    id: "scroll.toTop",
    scope: "pager",
    defaultKeys: ["g", "<home>"],
    description: "jump to top",
    group: "Pager",
  },
  {
    id: "scroll.toBottom",
    scope: "pager",
    defaultKeys: ["G", "<end>"],
    description: "jump to bottom",
    group: "Pager",
  },
  {
    id: "scroll.codeLeft",
    scope: "pager",
    defaultKeys: ["<left>"],
    description: "scroll code left",
    group: "Pager",
  },
  {
    id: "scroll.codeRight",
    scope: "pager",
    defaultKeys: ["<right>"],
    description: "scroll code right",
    group: "Pager",
  },
  {
    id: "scroll.codeLeftFast",
    scope: "pager",
    defaultKeys: ["<s-left>"],
    description: "scroll code left (fast)",
    group: "Pager",
  },
  {
    id: "scroll.codeRightFast",
    scope: "pager",
    defaultKeys: ["<s-right>"],
    description: "scroll code right (fast)",
    group: "Pager",
  },
  {
    id: "wrap.toggle",
    scope: "pager",
    defaultKeys: ["w"],
    description: "toggle line wrap",
    group: "Pager",
  },
  {
    id: "sidebar.toggle",
    scope: "pager",
    defaultKeys: ["s"],
    description: "toggle sidebar",
    group: "Pager",
  },

  // ---------- menu scope ----------
  {
    id: "menu.close",
    scope: "menu",
    defaultKeys: ["<esc>"],
    description: "close menu",
    group: "Menu",
  },
  {
    id: "menu.prev",
    scope: "menu",
    defaultKeys: ["<left>"],
    description: "previous menu",
    group: "Menu",
  },
  {
    id: "menu.next",
    scope: "menu",
    defaultKeys: ["<right>", "<tab>"],
    description: "next menu",
    group: "Menu",
  },
  {
    id: "menu.itemUp",
    scope: "menu",
    defaultKeys: ["<up>"],
    description: "previous item",
    group: "Menu",
  },
  {
    id: "menu.itemDown",
    scope: "menu",
    defaultKeys: ["<down>"],
    description: "next item",
    group: "Menu",
  },
  {
    id: "menu.activate",
    scope: "menu",
    defaultKeys: ["<enter>", "<return>"],
    description: "activate item",
    group: "Menu",
  },

  // ---------- filter scope ----------
  {
    id: "focus.toggle",
    scope: "filter",
    defaultKeys: ["<tab>"],
    description: "leave filter input",
    group: "Filter",
  },
];

/** All action definitions, indexed by scope. */
export const ACTIONS_BY_SCOPE: Record<ActionScope, readonly ActionDef[]> = {
  global: ACTIONS.filter((action) => action.scope === "global"),
  pager: ACTIONS.filter((action) => action.scope === "pager"),
  menu: ACTIONS.filter((action) => action.scope === "menu"),
  filter: ACTIONS.filter((action) => action.scope === "filter"),
};

/** Look up a single (scope, id) action definition. */
export function getAction<S extends ActionScope>(
  scope: S,
  id: ActionIdForScope<S>,
): ActionDef | undefined {
  return ACTIONS.find((action) => action.scope === scope && action.id === id);
}

/** Return every action defined in a scope, preserving registry order. */
export function getActionsInScope(scope: ActionScope): readonly ActionDef[] {
  return ACTIONS_BY_SCOPE[scope];
}
