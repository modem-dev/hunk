import type { KeyEvent } from "@opentui/core";

/**
 * Key-chord parsing and matching for the command registry.
 *
 * A chord is the textual form a binding is declared in — `"s"`, `"G"`,
 * `"ctrl+r"`, `"f10"`, `"["` — used by extension `registerCommand` calls and,
 * over time, user keymap config. Built-in commands may instead match with a
 * predicate when one logical action spans several physical keys (page-down is
 * `pagedown`, `space`, and `f`); chords and predicates meet at the
 * `KeyMatcher` shape so the dispatch loop treats them identically.
 */

/** Modifier-normalized description of one parsed chord. */
export interface ParsedKeyChord {
  /** The base key: a named key (`escape`, `f10`, `pageup`) or one character. */
  base: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
}

/** Named keys accepted as a chord base, normalized to OpenTUI's `key.name` values. */
const NAMED_KEYS = new Set([
  "escape",
  "tab",
  "space",
  "return",
  "enter",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedKeyChord, "base">> = {
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  alt: "option",
  option: "option",
  shift: "shift",
};

/**
 * Parse one chord string, or explain why it cannot be a binding.
 *
 * `"G"` means shift+g, matching how terminals report it; multi-character bases
 * must be known named keys so a typo like `"ctlr+s"` or `"f13"` is refused at
 * registration instead of silently never firing.
 */
export function parseKeyChord(chord: string): ParsedKeyChord | { error: string } {
  const tokens = chord
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  // A literal "+" binding arrives as empty tokens; treat the lone "+" specially.
  if (tokens.length === 0) {
    return chord.trim() === "+"
      ? { base: "+", ctrl: false, meta: false, option: false, shift: false }
      : { error: `Empty key chord "${chord}"` };
  }

  const parsed: ParsedKeyChord = {
    base: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
  };
  for (const [index, token] of tokens.entries()) {
    const modifier = MODIFIER_TOKENS[token.toLowerCase()];
    if (modifier && index < tokens.length - 1) {
      parsed[modifier] = true;
      continue;
    }

    if (index !== tokens.length - 1) {
      return { error: `Unknown modifier "${token}" in key chord "${chord}"` };
    }

    if (token.length === 1) {
      if (token !== token.toLowerCase() && token !== token.toUpperCase()) {
        return { error: `Unusable key "${token}" in key chord "${chord}"` };
      }

      // An uppercase letter is the shifted form of its lowercase key.
      if (/[A-Z]/.test(token)) {
        parsed.shift = true;
        parsed.base = token.toLowerCase();
      } else {
        parsed.base = token;
      }
      continue;
    }

    const named = token.toLowerCase();
    if (!NAMED_KEYS.has(named)) {
      return { error: `Unknown key "${token}" in key chord "${chord}"` };
    }

    parsed.base = named;
  }

  if (parsed.base.length === 0) {
    return { error: `Key chord "${chord}" names only modifiers` };
  }

  // Shifted symbols and digits have no layout-independent identity (shift+1 is
  // "!" on some keyboards and something else on others), so matching them by
  // modifier would be a guess. Refuse the form and ask for the character the
  // shift produces, which terminals report directly.
  if (parsed.shift && !NAMED_KEYS.has(parsed.base) && !isLetterBase(parsed.base)) {
    return {
      error:
        `Key chord "${chord}" uses shift with "${parsed.base}"; ` +
        `bind the shifted character itself instead (e.g. "!" rather than "shift+1")`,
    };
  }

  return parsed;
}

/** Report whether one base character is a letter, where shift changes the character. */
function isLetterBase(base: string) {
  return base.length === 1 && /[a-z]/.test(base);
}

/**
 * Report whether one key event is the parsed chord.
 *
 * Letters compare against `key.name` with an exact shift requirement, and the
 * shifted form also matches by uppercase `sequence` for terminals that report
 * `G` without a shift flag. Symbol bases compare by `sequence` and ignore the
 * shift flag entirely — `{` needs shift to type on most layouts, and whether
 * the terminal reports that is not the binding's business; the parser refuses
 * `shift+<symbol>` chords outright, so ignoring the flag here is consistent
 * rather than lossy.
 */
export function matchesKeyChord(parsed: ParsedKeyChord, key: KeyEvent): boolean {
  if (Boolean(key.ctrl) !== parsed.ctrl || Boolean(key.meta) !== parsed.meta) {
    return false;
  }

  if (Boolean(key.option) !== parsed.option) {
    return false;
  }

  if (NAMED_KEYS.has(parsed.base)) {
    const name = key.name?.toLowerCase();
    const aliasMatch =
      name === parsed.base ||
      // Terminals disagree on enter/return naming; treat them as one key.
      (parsed.base === "return" && name === "enter") ||
      (parsed.base === "enter" && name === "return");
    return aliasMatch && Boolean(key.shift) === parsed.shift;
  }

  if (isLetterBase(parsed.base)) {
    if (parsed.shift) {
      return (
        key.sequence === parsed.base.toUpperCase() ||
        (key.name === parsed.base && Boolean(key.shift))
      );
    }

    return (key.name === parsed.base || key.sequence === parsed.base) && !key.shift;
  }

  // Symbols and digits: the sequence is the character itself.
  return key.sequence === parsed.base || key.name === parsed.base;
}

/**
 * Build a synthetic key event that would satisfy the parsed chord.
 *
 * This exists for conflict detection: built-in commands may match with
 * predicates rather than chords, so the only way to ask "would this chord
 * collide with a built-in?" is to synthesize the event the chord describes and
 * run it through every matcher.
 */
export function synthesizeKeyEvent(parsed: ParsedKeyChord): KeyEvent {
  const isNamed = NAMED_KEYS.has(parsed.base);
  const sequence =
    isNamed || parsed.base.length !== 1
      ? ""
      : parsed.shift && isLetterBase(parsed.base)
        ? parsed.base.toUpperCase()
        : parsed.base;

  return {
    name: isNamed || isLetterBase(parsed.base) ? parsed.base : sequence,
    sequence,
    raw: sequence,
    ctrl: parsed.ctrl,
    meta: parsed.meta,
    option: parsed.option,
    shift: parsed.shift,
    number: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}
