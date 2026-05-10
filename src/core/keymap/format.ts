/**
 * Render parsed key specs back to human-readable strings for the help dialog.
 * The output is intentionally informal (`Ctrl+C`, `Esc`, `Shift+Space`)
 * rather than the angle-bracket token form — users reading help expect
 * familiar conventional names, not config syntax.
 */

import type { KeySpec } from "./parse";

const NAME_LABELS: Record<string, string> = {
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  enter: "Enter",
  backspace: "Backspace",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function labelForName(name: string): string {
  const label = NAME_LABELS[name];
  if (label) return label;
  if (/^f([1-9]|1[0-2])$/.test(name)) return name.toUpperCase();
  if (name.length === 1) return name.toUpperCase();
  return name;
}

/** Render one KeySpec for the help dialog. */
export function formatKeySpec(spec: KeySpec): string {
  if (spec.sequence !== undefined) {
    // Bare-character bindings render verbatim — they're already what the
    // user types.
    return spec.sequence;
  }

  const parts: string[] = [];
  if (spec.ctrl) parts.push("Ctrl");
  if (spec.alt) parts.push("Alt");
  if (spec.meta) parts.push("Meta");
  if (spec.shift) parts.push("Shift");

  if (spec.name !== undefined) {
    parts.push(labelForName(spec.name));
  }

  return parts.join("+");
}

/** Join multiple bindings for the same action with " / ". */
export function formatBinding(specs: KeySpec[]): string {
  if (specs.length === 0) return "disabled";
  return specs.map(formatKeySpec).join(" / ");
}
