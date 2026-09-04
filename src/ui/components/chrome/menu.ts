import { measureTextWidth } from "../../lib/text";

export type MenuId = "file" | "view" | "navigate" | "commit" | "agent" | "extensions" | "help";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** The command this item runs; a stable render identity, since labels may repeat. */
      commandId?: string;
      hint?: string;
      checked?: boolean;
      /** Keep a context-dependent action visible while preventing activation. */
      disabled?: boolean;
      action: () => void;
    }
  | {
      kind: "separator";
    };

export interface MenuSpec {
  id: MenuId;
  left: number;
  width: number;
  label: string;
}

/**
 * The dropdown menus one session shows.
 *
 * Every id is optional because not all menus always exist: Extensions is there
 * only when an extension registered a command, and a menu bar with an empty
 * dropdown on it would be worse than no menu.
 */
export type AppMenus = Partial<Record<MenuId, MenuEntry[]>>;

const MENU_LABELS: Record<MenuId, string> = {
  file: "File",
  view: "View",
  navigate: "Navigate",
  commit: "Commit",
  agent: "Agent",
  extensions: "Extensions",
  help: "Help",
};

export const MENU_ORDER = Object.keys(MENU_LABELS) as MenuId[];

/** The entries of one menu, or none when the session does not show it. */
export function menuEntries(menus: AppMenus, id: MenuId): MenuEntry[] {
  return menus[id] ?? [];
}

/**
 * Compute menu-bar positions for the menus this session actually has.
 *
 * Positions follow `MENU_ORDER`, but a menu with nothing in it takes no space
 * and no label: what the bar shows and what the keyboard cycles through are the
 * same derived list, so neither can point at a menu that is not there.
 */
export function buildMenuSpecs(menus: AppMenus) {
  return MENU_ORDER.filter((id) => menuEntries(menus, id).length > 0).reduce<MenuSpec[]>(
    (items, id) => {
      const previous = items.at(-1);
      // Each menu label already includes its own leading/trailing padding inside the fixed-width
      // box, so adjacent menu boxes are packed directly next to each other without an extra gap.
      const left = previous ? previous.left + previous.width : 1;
      items.push({
        id,
        left,
        width: MENU_LABELS[id].length + 2,
        label: MENU_LABELS[id],
      });
      return items;
    },
    [],
  );
}

/** Fit a shared ordered menu model into one bar and retain hidden menus behind overflow. */
export function responsiveMenuSpecs(menuSpecs: readonly MenuSpec[], terminalWidth: number) {
  const rightEdge = Math.max(1, terminalWidth - 1);
  const allVisible = menuSpecs.filter((menu) => menu.left + menu.width <= rightEdge);
  if (allVisible.length === menuSpecs.length) {
    return { visible: allVisible, hidden: [] as MenuSpec[], overflowLeft: null };
  }

  const overflowWidth = 3;
  const visible = menuSpecs.filter((menu) => menu.left + menu.width + overflowWidth <= rightEdge);
  const visibleIds = new Set(visible.map((menu) => menu.id));
  const hidden = menuSpecs.filter((menu) => !visibleIds.has(menu.id));
  const previous = visible.at(-1);
  return {
    visible,
    hidden,
    overflowLeft: previous ? previous.left + previous.width : 1,
  };
}

/** Find the next selectable menu item, skipping separators. */
export function nextMenuItemIndex(entries: MenuEntry[], currentIndex: number, delta: number) {
  if (entries.length === 0) {
    return 0;
  }

  let candidate = currentIndex;
  for (let remaining = entries.length; remaining > 0; remaining -= 1) {
    candidate = (candidate + delta + entries.length) % entries.length;
    const entry = entries[candidate];
    if (entry?.kind === "item" && !entry.disabled) {
      return candidate;
    }
  }

  return 0;
}

/** Build the widest text form a dropdown item may need. */
function menuEntryText(entry: Extract<MenuEntry, { kind: "item" }>) {
  const check = entry.checked === undefined ? "    " : entry.checked ? "[x] " : "[ ] ";
  const hint = entry.hint ? ` ${entry.hint}` : "";
  return `${check}${entry.label}${hint}`;
}

/** Compute a dropdown content width that fits its longest entry with a little breathing room. */
export function menuWidth(entries: MenuEntry[]) {
  return Math.max(
    20,
    // Terminal cells, not code units: extension command titles can carry CJK or
    // emoji, which render two cells wide and would otherwise be clipped.
    ...entries.map((entry) =>
      entry.kind === "separator" ? 6 : measureTextWidth(menuEntryText(entry)) + 2,
    ),
  );
}

/**
 * Cells available for the changeset title beside the menus on the top bar.
 *
 * Derived from the specs the bar actually renders, so a session that shows the
 * Extensions menu cedes its width to the menus instead of overdrawing the row.
 * The constant covers the bar's own padding, the title's leading space, and a
 * little breathing room between the last menu and the title.
 */
export function menuBarTitleWidth(menuSpecs: readonly MenuSpec[], terminalWidth: number) {
  const menusWidth = menuSpecs.reduce((total, spec) => total + spec.width, 0);
  return Math.max(0, terminalWidth - menusWidth - 6);
}

/** Return the border-inclusive height of a dropdown menu. */
export function menuBoxHeight(entries: MenuEntry[]) {
  return entries.length + 2;
}
