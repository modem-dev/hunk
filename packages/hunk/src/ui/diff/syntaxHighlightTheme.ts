import { createHash } from "node:crypto";
import {
  registerCustomTheme,
  resolveTheme as resolvePierreTheme,
  type DiffsTheme,
} from "@pierre/diffs";
import type { AppTheme } from "../themes";

/**
 * Selects Pierre's highlighter backend for terminal, worker, and document highlighting.
 *
 * `HUNK_EXPERIMENTAL_HIGHLIGHTS=1` opts into Pierre Highlights (beta) in place of Shiki WASM.
 * Pierre allows one backend per process, so the choice is fixed at startup; the highlight worker
 * reads the same inherited environment.
 */
export const PIERRE_SYNTAX_HIGHLIGHTER =
  process.env.HUNK_EXPERIMENTAL_HIGHLIGHTS === "1" ? "highlights" : "shiki-wasm";

const PIERRE_THEME = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

type TextMateTheme = NonNullable<DiffsTheme["textmate"]>;
type ZedTheme = NonNullable<DiffsTheme["zed"]>;
type ZedSyntax = NonNullable<ZedTheme["style"]["syntax"]>;

const registeredSyntaxThemes = new Set<string>();

/**
 * Pairs each Highlights syntax key with the TextMate scope its tokens carry in Shiki grammars.
 *
 * A configured TextMate selector colors a key when it is a dot-boundary prefix of that scope, the
 * way TextMate selectors match. Keys absent here inherit through Highlights' dotted fallback
 * (`function.method` falls back to `function`). Language-suffixed selectors such as
 * `entity.name.function.ts` cannot match because Highlights keys carry no language.
 */
const HIGHLIGHTS_KEY_SCOPES: Record<string, string> = {
  comment: "comment.line",
  "comment.doc": "comment.block.documentation",
  string: "string.quoted",
  "string.escape": "constant.character.escape",
  "string.regex": "string.regexp",
  "string.special": "string.other",
  "string.special.symbol": "constant.other.symbol",
  "string.template": "string.template",
  template_string: "string.template",
  "string.plain": "string.unquoted",
  number: "constant.numeric",
  "number.unit": "keyword.other.unit",
  boolean: "constant.language.boolean",
  constant: "constant.other",
  "constant.color": "constant.other.color",
  keyword: "keyword.control",
  "keyword.operator": "keyword.operator",
  operator: "keyword.operator",
  "keyword.directive": "keyword.control.directive",
  preproc: "keyword.control.directive",
  "keyword.control.at-rule": "keyword.control.at-rule",
  at_keyword: "keyword.control.at-rule",
  "keyword.important": "keyword.other.important",
  function: "entity.name.function",
  "function.call": "variable.function",
  "function.method.call": "variable.function",
  "function.builtin": "support.function",
  type: "entity.name.type",
  "type.builtin": "support.type.primitive",
  class: "entity.name.class",
  class_name: "entity.name.class",
  constructor: "entity.name.class",
  variable: "variable.other.readwrite",
  "variable.parameter": "variable.parameter",
  "variable.builtin": "variable.language",
  "variable.language": "variable.language",
  this: "variable.language",
  self: "variable.language",
  "variable.member": "variable.other.property",
  property: "variable.other.property",
  property_identifier: "variable.other.property",
  "property.css": "support.type.property-name",
  "property.custom": "variable.css",
  value: "support.constant.property-value",
  tag: "entity.name.tag",
  tag_name: "entity.name.tag",
  attribute: "entity.other.attribute-name",
  "selector.class": "entity.other.attribute-name.class",
  "selector.id": "entity.other.attribute-name.id",
  "selector.pseudo": "entity.other.attribute-name.pseudo-class",
  punctuation: "punctuation.section",
  "punctuation.bracket": "punctuation.section",
  "punctuation.delimiter": "punctuation.separator",
  "punctuation.special": "punctuation.definition.template-expression",
  "punctuation.list_marker": "punctuation.definition.list",
  namespace: "entity.name.namespace",
  decorator: "meta.decorator",
  label: "entity.name.label",
  embedded: "meta.embedded",
  "markup.heading": "markup.heading",
  title: "markup.heading",
  "markup.bold": "markup.bold",
  "emphasis.strong": "markup.bold",
  "markup.italic": "markup.italic",
  emphasis: "markup.italic",
  "markup.strikethrough": "markup.strikethrough",
  "markup.link.url": "markup.underline.link",
  link_uri: "markup.underline.link",
  "markup.link.text": "string.other.link",
  link_text: "string.other.link",
  "markup.quote": "markup.quote",
  "markup.list": "markup.list",
  "markup.raw": "markup.inline.raw",
  "text.literal": "markup.inline.raw",
  "diff.plus": "markup.inserted",
  "diff.minus": "markup.deleted",
  "diff.delta": "markup.changed",
};

/** Return whether a TextMate selector matches a scope at a dot boundary. */
function scopeSelectorMatches(selector: string, scope: string) {
  return scope === selector || scope.startsWith(`${selector}.`);
}

/**
 * Translate TextMate scope colors into Highlights syntax colors.
 *
 * Per key, the longest matching selector wins and later entries break ties, approximating
 * TextMate's specificity and declaration-order rules.
 */
function scopeOverridesToHighlightsSyntax(scopeOverrides: Record<string, string>) {
  const syntax: Record<string, string> = {};
  for (const [key, scope] of Object.entries(HIGHLIGHTS_KEY_SCOPES)) {
    let best: { length: number; color: string } | undefined;
    for (const [selector, color] of Object.entries(scopeOverrides)) {
      if (!scopeSelectorMatches(selector, scope)) continue;
      if (!best || selector.length >= best.length) best = { length: selector.length, color };
    }
    if (best) syntax[key] = best.color;
  }
  return syntax;
}

/** Build a stable id so each distinct scope palette gets its own highlighter cache entry. */
function syntaxThemeFingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Derive a Shiki theme by appending TextMate scope colors unchanged, or, when the theme asks to
 * replace its base, by keeping only those colors and making `source` the default foreground.
 */
async function buildCustomTextMateTheme(
  name: string,
  baseThemeName: string,
  scopeOverrides: Record<string, string>,
  replaceBase: boolean,
) {
  const resolvedBase = await resolvePierreTheme(baseThemeName, PIERRE_SYNTAX_HIGHLIGHTER);
  const baseTheme = resolvedBase.textmate;
  if (!baseTheme) throw new Error(`Theme "${baseThemeName}" has no TextMate palette.`);
  const scopeSettings = Object.entries(scopeOverrides).map(([scope, foreground]) => ({
    scope,
    settings: { foreground },
  }));

  if (!replaceBase) {
    return {
      ...baseTheme,
      name,
      settings: [...(baseTheme.settings ?? []), ...scopeSettings],
    } satisfies TextMateTheme;
  }

  const foreground = scopeOverrides.source ?? baseTheme.fg;
  return {
    ...baseTheme,
    name,
    fg: foreground,
    colors: { ...baseTheme.colors, "editor.foreground": foreground },
    settings: [{ settings: { foreground } }, ...scopeSettings],
  } satisfies TextMateTheme;
}

/**
 * Derive a Highlights theme by layering translated scope colors over the base palette, or, when
 * the theme asks to replace its base, by keeping only those colors and making `source` the
 * default foreground.
 */
async function buildCustomHighlightsTheme(
  name: string,
  baseThemeName: string,
  scopeOverrides: Record<string, string>,
  replaceBase: boolean,
) {
  const resolvedBase = await resolvePierreTheme(baseThemeName, PIERRE_SYNTAX_HIGHLIGHTER);
  const baseTheme = resolvedBase.zed;
  if (!baseTheme) throw new Error(`Theme "${baseThemeName}" has no Highlights palette.`);

  const translated: ZedSyntax = {};
  for (const [key, color] of Object.entries(scopeOverridesToHighlightsSyntax(scopeOverrides))) {
    const baseSettings = baseTheme.style.syntax?.[key];
    translated[key] = typeof baseSettings === "object" ? { ...baseSettings, color } : { color };
  }

  const foreground = scopeOverrides.source;
  const style = {
    ...baseTheme.style,
    ...(foreground ? { "editor.foreground": foreground, text: foreground } : {}),
    syntax: replaceBase ? translated : { ...baseTheme.style.syntax, ...translated },
  };
  return { ...baseTheme, name, style } satisfies ZedTheme;
}

/** Resolve the content-addressed syntax theme name used for one Hunk app theme. */
export function syntaxHighlightThemeName(theme: AppTheme | AppTheme["appearance"]) {
  if (typeof theme === "string") {
    return PIERRE_THEME[theme];
  }

  const baseThemeName = theme.syntaxTheme ?? PIERRE_THEME[theme.appearance];
  // TextMate resolves equally specific rules by declaration order, so order is part of identity.
  const orderedOverrides = Object.entries(theme.syntaxScopeOverrides ?? {}).map(
    ([scope, color]) => [scope, color.toLowerCase()],
  );
  const fingerprintInput = JSON.stringify({
    baseThemeName,
    orderedOverrides,
    ...(theme.syntaxScopesReplaceBase ? { replaceBase: true } : {}),
  });

  return orderedOverrides.length > 0
    ? `hunk-custom-${syntaxThemeFingerprint(fingerprintInput)}`
    : baseThemeName;
}

/** Return whether the worker can resolve this theme without main-thread scope registration. */
export function themeSupportsHighlightWorker(theme: AppTheme) {
  return Object.keys(theme.syntaxScopeOverrides ?? {}).length === 0;
}

/** Register a derived scope theme before Pierre asks its shared highlighter to resolve it. */
export function ensureSyntaxHighlightThemeRegistered(theme: AppTheme | AppTheme["appearance"]) {
  const themeName = syntaxHighlightThemeName(theme);
  if (typeof theme === "string" || !theme.syntaxScopeOverrides) {
    return themeName;
  }

  const baseThemeName = theme.syntaxTheme ?? PIERRE_THEME[theme.appearance];
  if (themeName === baseThemeName) {
    return themeName;
  }

  if (!registeredSyntaxThemes.has(themeName)) {
    const capturedOverrides = { ...theme.syntaxScopeOverrides };
    const replaceBase = theme.syntaxScopesReplaceBase === true;
    if (PIERRE_SYNTAX_HIGHLIGHTER === "highlights") {
      registerCustomTheme(
        themeName,
        () => buildCustomHighlightsTheme(themeName, baseThemeName, capturedOverrides, replaceBase),
        "zed",
      );
    } else {
      registerCustomTheme(themeName, () =>
        buildCustomTextMateTheme(themeName, baseThemeName, capturedOverrides, replaceBase),
      );
    }
    registeredSyntaxThemes.add(themeName);
  }

  return themeName;
}
