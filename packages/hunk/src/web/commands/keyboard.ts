/**
 * Maps the browser's key events onto the shared chord grammar and decides which ones the page
 * may claim.
 *
 * Chords are the shared vocabulary (`extension-api/keys.ts`, the grammar the terminal, the
 * user's `[keybindings]`, and extensions all speak); this module only translates a DOM
 * `KeyboardEvent` into the structural key event that grammar matches, and applies the
 * browser's own rules about what a page must leave alone:
 *
 * - Chords carrying Ctrl, Cmd, or Alt, Tab, and the function keys belong to the browser and
 *   the OS (find, copy, back and forward, zoom, tab switching, reload, focus traversal), so
 *   the page never binds them, whatever the keymap says.
 * - Nothing fires while focus is in a text field, a select, or editable content.
 * - A focused control keeps the keys that operate it: Space and Enter on a button, and the
 *   arrow, paging, and Home/End keys inside a composite widget such as a radio group, menu,
 *   or the files tree.
 *
 * The keymap is chords per command id. The page starts from the catalog's defaults; once the
 * state route delivers the host's resolved keymap (`[keybindings]` folded in on the host,
 * audit F3), it replaces the defaults through the same `WebKeymap` shape.
 */
import { matchesKeyChord, parseKeyChord, type ParsedKeyChord } from "../../extension-api/keys";
import type { ExtensionKeyEvent } from "../../extension-api/types";
import { APP_COMMAND_CATALOG } from "../../core/run/commandCatalog";
import type { WebCommand } from "./webCommandTable";

/** Chords per command id, as the catalog ships them or as the host resolved them. */
export type WebKeymap = ReadonlyMap<string, readonly string[]>;

/** The catalog's default chords for every built-in command. */
export function defaultWebKeymap(): WebKeymap {
  return new Map(APP_COMMAND_CATALOG.map((entry) => [entry.id, entry.defaultKeys]));
}

/** DOM `KeyboardEvent.key` names for the named keys the chord grammar knows. */
const DOM_NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Home: "home",
  End: "end",
  Escape: "escape",
  Enter: "return",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  " ": "space",
};

/** The parts of a DOM keyboard event this module reads. */
export type WebKeyboardEventLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & { isComposing?: boolean };

/**
 * Translate one DOM key event into the structural event the chord grammar matches.
 *
 * Returns nothing for events that name no key the grammar can bind (modifier presses, dead
 * keys, IME composition). A letter's `name` is its lowercase form only when Shift is down, so
 * Caps Lock `G` matches the `G` chord by its sequence and never the `g` one.
 */
export function webKeyEvent(event: WebKeyboardEventLike): ExtensionKeyEvent | undefined {
  if (event.isComposing) return undefined;
  const modifiers = {
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    option: event.altKey,
    shift: event.shiftKey,
  };
  const named = DOM_NAMED_KEYS[event.key];
  if (named) {
    return { name: named, ...(named === "space" ? { sequence: " " } : {}), ...modifiers };
  }
  if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    return { name: event.key.toLowerCase(), ...modifiers };
  }
  // One printable character (letters, digits, symbols, any script); anything longer is a
  // key name the grammar has no use for ("Shift", "Dead", "Unidentified", "Process").
  if ([...event.key].length !== 1) return undefined;
  const name = /^[A-Za-z]$/.test(event.key) && event.shiftKey ? event.key.toLowerCase() : event.key;
  return { name, sequence: event.key, ...modifiers };
}

/**
 * Explain why the browser reserves one chord, or return nothing when the page may bind it.
 *
 * Deliberately broad: a reader's muscle memory for their browser is worth more than any one
 * Hunk shortcut, and every catalogued command keeps at least one unmodified chord.
 */
export function browserReservedChordReason(chord: ParsedKeyChord): string | undefined {
  if (chord.ctrl || chord.meta || chord.option) {
    return "Ctrl, Cmd, and Alt chords belong to the browser and the operating system.";
  }
  if (chord.base === "tab") return "Tab moves keyboard focus.";
  if (/^f\d{1,2}$/.test(chord.base)) return "Function keys belong to the browser.";
  return undefined;
}

/** The chords the page may bind for one command, parsed, with reserved chords removed. */
export function bindableWebChords(chords: readonly string[]): ParsedKeyChord[] {
  return chords.flatMap((chord) => {
    const parsed = parseKeyChord(chord);
    return "error" in parsed || browserReservedChordReason(parsed) ? [] : [parsed];
  });
}

/** The chords one command answers to on this page, as written, for labels. */
export function webCommandChords(keymap: WebKeymap, commandId: string): string[] {
  return (keymap.get(commandId) ?? []).filter((chord) => {
    const parsed = parseKeyChord(chord);
    return !("error" in parsed) && !browserReservedChordReason(parsed);
  });
}

/** Keys a focused control or composite widget operates itself. */
const BUTTON_KEYS = new Set(["space", "return"]);
const COMPOSITE_KEYS = new Set([
  "space",
  "return",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);
const COMPOSITE_ROLES = new Set([
  "radiogroup",
  "radio",
  "menu",
  "menuitem",
  "menuitemradio",
  "listbox",
  "option",
  "tree",
  "treeitem",
  "grid",
  "tablist",
  "tab",
  "slider",
  "separator",
]);

/** Whether one event target is an element (a window or document is not). */
function isElementLike(target: EventTarget): target is Element {
  return (
    typeof (target as Element).tagName === "string" &&
    typeof (target as Element).getAttribute === "function"
  );
}

/** Whether one element takes typed text, where every key belongs to it. */
function isTextEntry(element: Element) {
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "reset", "submit", "image", "range", "color"].includes(
      type,
    );
  }
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * Decide whether the focused element keeps this key for itself.
 *
 * `path` is the event's composed path, innermost first, so focus inside a shadow root (the
 * files tree) is seen for what it is.
 */
export function focusOwnsKey(path: readonly EventTarget[], key: ExtensionKeyEvent) {
  for (const target of path) {
    // Duck-typed rather than `instanceof Element`, so the rule is testable without a DOM.
    if (!isElementLike(target)) continue;
    if (isTextEntry(target)) return true;
    const role = target.getAttribute("role");
    if (role && COMPOSITE_ROLES.has(role)) return COMPOSITE_KEYS.has(key.name ?? "");
    if (target.tagName === "FILE-TREE-CONTAINER") return COMPOSITE_KEYS.has(key.name ?? "");
    if (target.tagName === "BUTTON" || target.tagName === "A" || role === "button") {
      return BUTTON_KEYS.has(key.name ?? "");
    }
  }
  return false;
}

/** The commands with their bindable chords, ready to match key events in catalog order. */
export interface WebKeyBindings {
  match(event: ExtensionKeyEvent): WebCommand | undefined;
}

/** Bind the page's commands to the keymap's chords, masking what the browser reserves. */
export function bindWebCommands(
  commands: readonly WebCommand[],
  keymap: WebKeymap,
): WebKeyBindings {
  const bound = commands.map((command) => ({
    command,
    chords: bindableWebChords(keymap.get(command.entry.id) ?? []),
  }));
  return {
    match(event) {
      // A modified key is always the browser's, even if a keymap somehow carried the chord.
      if (event.ctrl || event.meta || event.option) return undefined;
      return bound.find(({ chords }) => chords.some((chord) => matchesKeyChord(chord, event)))
        ?.command;
    },
  };
}
