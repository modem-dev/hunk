/**
 * Token parser for keybinding strings. The grammar mirrors lazygit's:
 *
 *   - `<disabled>`              => sentinel that unbinds an action.
 *   - `<name>`                  => named special key (`esc`, `tab`, `f10`, ...).
 *   - `<c-x>` / `<s-up>` / ...  => named key with modifier prefixes (`c-`, `s-`,
 *                                 `a-`, `m-`). Modifiers may stack (`<c-s-a>`).
 *   - bare `q`, `?`, `[`, `{`   => literal printable; matched by `key.sequence`.
 *
 * No multi-key sequences are supported in v1 (single chord per binding).
 */

export interface KeySpec {
  /** Named OpenTUI `key.name` to match (e.g. `escape`, `f10`, `tab`). */
  name?: string;
  /** Literal `key.sequence` to match for bare-character bindings. */
  sequence?: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  alt: boolean;
}

const NAMED_KEY_TOKENS: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  tab: "tab",
  space: "space",
  enter: "enter",
  return: "enter",
  backspace: "backspace",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pgup: "pageup",
  pageup: "pageup",
  pgdown: "pagedown",
  pagedown: "pagedown",
};

function isFunctionKeyToken(token: string): boolean {
  if (token.length < 2 || token.length > 3) return false;
  if (token[0] !== "f") return false;
  const num = Number(token.slice(1));
  return Number.isInteger(num) && num >= 1 && num <= 12;
}

/**
 * Parse a single binding token. Returns `"disabled"` for the unbind sentinel
 * and `null` on parse error so the caller can log and ignore.
 */
export function parseKeyToken(rawToken: string): KeySpec | "disabled" | null {
  const token = rawToken.trim();
  if (token.length === 0) return null;

  // Bare single character (and not enclosed in <>): literal sequence match.
  if (token[0] !== "<") {
    if (token.length !== 1) {
      // Anything multi-character outside angle brackets is a parse error.
      return null;
    }
    return {
      sequence: token,
      ctrl: false,
      shift: false,
      meta: false,
      alt: false,
    };
  }

  if (token[token.length - 1] !== ">") return null;
  const inner = token.slice(1, -1).toLowerCase();
  if (inner.length === 0) return null;

  if (inner === "disabled") return "disabled";

  const parts = inner.split("-");
  let ctrl = false;
  let shift = false;
  let meta = false;
  let alt = false;

  // Modifier prefixes ("c", "s", "m", "a") in any order; the final segment is
  // always the key name (or a single literal char).
  while (parts.length > 1) {
    const head = parts[0];
    if (head === "c") {
      ctrl = true;
    } else if (head === "s") {
      shift = true;
    } else if (head === "m") {
      meta = true;
    } else if (head === "a") {
      alt = true;
    } else {
      break;
    }
    parts.shift();
  }

  if (parts.length !== 1) return null;
  const keyToken = parts[0];
  if (keyToken === undefined) return null;

  const namedKey = NAMED_KEY_TOKENS[keyToken];
  if (namedKey) {
    return {
      name: namedKey,
      ctrl,
      shift,
      meta,
      alt,
    };
  }

  if (isFunctionKeyToken(keyToken)) {
    return {
      name: keyToken,
      ctrl,
      shift,
      meta,
      alt,
    };
  }

  // Single character with modifiers (e.g. `<c-c>`). We match by `key.name`
  // because OpenTUI emits `name === "c"` for `Ctrl+C`.
  if (keyToken.length === 1) {
    return {
      name: keyToken,
      ctrl,
      shift,
      meta,
      alt,
    };
  }

  return null;
}

export interface ParsedBinding {
  /** Parsed specs in source order. Empty if the binding is disabled. */
  specs: KeySpec[];
  /** True when any token was `<disabled>` — caller should treat as unbound. */
  disabled: boolean;
  /**
   * True when `<disabled>` appeared alongside any other token (parsed or
   * rejected). Pure `"<disabled>"` is *not* mixed; only loud combinations
   * like `["q", "<disabled>"]` set this flag so callers can warn that the
   * other tokens were silently dropped.
   */
  mixedWithDisabled: boolean;
  /** Tokens that failed to parse, surfaced so callers can warn with context. */
  rejectedTokens: string[];
}

/** Parse a binding value (single string or array) into normalized specs. */
export function parseBinding(value: string | string[]): ParsedBinding {
  const tokens = Array.isArray(value) ? value : [value];
  const specs: KeySpec[] = [];
  const rejectedTokens: string[] = [];
  let disabled = false;
  // Track non-disabled tokens separately so the "disabled wins" zeroing
  // doesn't erase the evidence we need for mixedWithDisabled.
  let hadOtherTokens = false;

  for (const token of tokens) {
    if (typeof token !== "string") {
      rejectedTokens.push(String(token));
      hadOtherTokens = true;
      continue;
    }
    const parsed = parseKeyToken(token);
    if (parsed === "disabled") {
      // Disabled wins; callers ignore specs when disabled is set.
      disabled = true;
      continue;
    }
    if (parsed === null) {
      rejectedTokens.push(token);
      hadOtherTokens = true;
      continue;
    }
    specs.push(parsed);
    hadOtherTokens = true;
  }

  const mixedWithDisabled = disabled && hadOtherTokens;

  if (disabled) {
    return { specs: [], disabled: true, mixedWithDisabled, rejectedTokens };
  }

  return { specs, disabled: false, mixedWithDisabled, rejectedTokens };
}
