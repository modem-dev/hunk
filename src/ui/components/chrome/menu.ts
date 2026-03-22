export type MenuId = "file" | "view" | "navigate" | "theme" | "agent" | "help";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      hint?: string;
      checked?: boolean;
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

const MENU_LABELS: Record<MenuId, string> = {
  file: "File",
  view: "View",
  navigate: "Navigate",
  theme: "Theme",
  agent: "Agent",
  help: "Help",
};

export const MENU_ORDER = Object.keys(MENU_LABELS) as MenuId[];

/** Compute menu-bar positions from the fixed top-level menu order. */
export function buildMenuSpecs() {
  return MENU_ORDER.reduce<MenuSpec[]>((items, id) => {
    const previous = items.at(-1);
    const left = previous ? previous.left + previous.width + 1 : 1;
    items.push({
      id,
      left,
      width: MENU_LABELS[id].length + 2,
      label: MENU_LABELS[id],
    });
    return items;
  }, []);
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
    if (entry?.kind === "item") {
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

/** Compute a dropdown width that fits its longest entry with a small floor. */
export function menuWidth(entries: MenuEntry[]) {
  return Math.max(
    18,
    ...entries.map((entry) => (entry.kind === "separator" ? 6 : menuEntryText(entry).length)),
  );
}

/** Return the border-inclusive height of a dropdown menu. */
export function menuBoxHeight(entries: MenuEntry[]) {
  return entries.length + 2;
}
