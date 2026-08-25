/**
 * The key-chord grammar, published as part of `hunkdiff/extension`.
 *
 * A chord is the textual form a binding is declared in — `"s"`, `"G"`,
 * `"ctrl+r"`, `"f10"`, `"["`. Hunk's own shortcuts, extension
 * `registerCommand` bindings, and the user's `[keybindings]` config table all
 * speak this one grammar, and extension components that need their own internal
 * keys match with it too, instead of hand-reading key events.
 *
 * Every module the `hunkdiff/extension` entry reaches is published by
 * declaration emission, so this file reaches nothing but the contract itself:
 * its one import is a type-only import of `./types`, the other published
 * module, and no Hunk internal is reachable from either. `ExtensionKeyEvent`
 * lives there because the file-view mode contract needs it too; it is declared
 * structurally rather than pulled from OpenTUI, so a component can pass the
 * event it was handed straight through.
 */

import type { ExtensionKeyEvent } from "./types.js";

export type { ExtensionKeyEvent };

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
 * Report whether a key event is the bare C0 byte `ctrl+<letter>` is sent as.
 *
 * A compatibility net, not the primary path. `ExtensionKeyEvent` is a
 * structural type and this matcher is published, so it is handed events Hunk's
 * own input pipeline never built — synthetic events from tests, events an
 * embedder or another host passes to an extension component, events assembled
 * by hand — and such a source may forward the byte without decoding it. Under
 * Hunk's own OpenTUI parser the byte arrives already decoded as `ctrl: true`
 * with `name: "s"`, which the normal path below matches, so this clause never
 * fires for a real Hunk keypress. The undecoded form is
 * `sequence: "\u0013"` with no `ctrl` flag and no `name` at all, so matching on
 * the flag alone would silently never fire. `ctrl+a`…`ctrl+z` map onto
 * `0x01`…`0x1a`, which is the whole of this fallback — it never makes a control
 * byte printable or matchable as text anywhere else.
 *
 * An event that carries a `name` is left to name-based matching: Tab is `0x09`
 * (`ctrl+i`) and Enter is `0x0d` (`ctrl+m`), and a source that decoded those
 * into `name: "tab"` / `name: "return"` has told us which key it was, so a
 * `ctrl+i` binding must not swallow Tab. Other modifier flags disqualify the
 * event for the same reason the normal path compares them exactly: a C0 byte
 * carries no modifier of its own, so a reported meta/option/shift belongs to a
 * different chord than the plain `ctrl+<letter>` one.
 */
function matchesControlCharacter(parsed: ParsedKeyChord, key: ExtensionKeyEvent) {
  if (!parsed.ctrl || parsed.meta || parsed.option || parsed.shift) return false;
  if (!isLetterBase(parsed.base)) return false;
  if (key.name || key.meta || key.option || key.shift) return false;

  // "a" is 0x61 and ctrl+a is 0x01, so the control byte is the letter less 0x60.
  return key.sequence === String.fromCharCode(parsed.base.charCodeAt(0) - 0x60);
}

/** Report whether one key event names a key, allowing for terminal naming disagreements. */
function matchesNamedKey(base: string, key: ExtensionKeyEvent) {
  const name = key.name?.toLowerCase();
  if (name === base) {
    return true;
  }

  // Terminals disagree on enter/return naming; treat them as one key.
  if ((base === "return" && name === "enter") || (base === "enter" && name === "return")) {
    return true;
  }

  // Space arrives named "space" from OpenTUI's parser, but as the bare
  // character from other input paths, so accept both spellings of one key.
  return base === "space" && (name === " " || key.sequence === " ");
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
 *
 * A plain `ctrl+<letter>` chord additionally matches the bare C0 control
 * character the combination is sent as, for events from sources that do not
 * decode it — see {@link matchesControlCharacter} for who those are, why
 * Hunk's own keypresses take the normal path instead, and why a named event
 * (Tab, Enter) is never claimed by the fallback.
 */
export function matchesKeyChord(parsed: ParsedKeyChord, key: ExtensionKeyEvent): boolean {
  // Before the modifier gate: the whole point of the C0 form is that the event
  // carries no `ctrl` flag to compare against.
  if (matchesControlCharacter(parsed, key)) {
    return true;
  }

  if (Boolean(key.ctrl) !== parsed.ctrl || Boolean(key.meta) !== parsed.meta) {
    return false;
  }

  if (Boolean(key.option) !== parsed.option) {
    return false;
  }

  if (NAMED_KEYS.has(parsed.base)) {
    return matchesNamedKey(parsed.base, key) && Boolean(key.shift) === parsed.shift;
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
 * Report whether one key event is the chord, parsing the chord on the way.
 *
 * The convenience form for extension UI: a component with internal keys asks
 * `matchesKey("ctrl+n", key)` rather than reading modifier flags itself, and
 * gets exactly the matching rules Hunk's own shortcuts use. An unparsable chord
 * matches nothing — a typo is a binding that never fires, never one that
 * swallows unrelated keys.
 */
export function matchesKey(chord: string, key: ExtensionKeyEvent): boolean {
  const parsed = parseKeyChord(chord);
  return "error" in parsed ? false : matchesKeyChord(parsed, key);
}
