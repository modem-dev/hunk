import type { CustomSyntaxColorsConfig, CustomSyntaxScopesConfig } from "./types";

/** Deprecated role keys accepted only during the temporary configuration migration window. */
export const LEGACY_CUSTOM_SYNTAX_COLOR_KEYS = [
  "default",
  "keyword",
  "string",
  "comment",
  "number",
  "function",
  "property",
  "type",
  "variable",
  "operator",
  "punctuation",
] as const satisfies readonly (keyof CustomSyntaxColorsConfig)[];

/**
 * Temporary compatibility map for the deprecated [custom_theme.syntax] role table.
 *
 * Keep this adapter isolated from the highlighter: new code must use exact TextMate scopes through
 * [custom_theme.syntax_scopes]. Remove this file in the next major release after the migration
 * window. These selectors are intentionally approximate because semantic roles do not have a
 * one-to-one relationship with language-specific TextMate grammars.
 */
const LEGACY_SYNTAX_ROLE_SCOPES: Record<keyof CustomSyntaxColorsConfig, readonly string[]> = {
  default: ["source"],
  keyword: ["keyword"],
  string: ["string"],
  comment: ["comment", "punctuation.definition.comment"],
  number: ["constant.numeric"],
  function: ["entity.name.function", "support.function", "variable.function"],
  property: ["variable.other.property", "support.variable.property"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  variable: ["variable"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation"],
};

/** Translate deprecated semantic colors into approximate TextMate scope rules. */
export function legacySyntaxColorsToScopes(
  syntax: CustomSyntaxColorsConfig | undefined,
): CustomSyntaxScopesConfig | undefined {
  if (!syntax) {
    return undefined;
  }

  const scopes: CustomSyntaxScopesConfig = {};
  for (const role of LEGACY_CUSTOM_SYNTAX_COLOR_KEYS) {
    const color = syntax[role];
    if (!color) {
      continue;
    }

    for (const scope of LEGACY_SYNTAX_ROLE_SCOPES[role]) {
      scopes[scope] = color;
    }
  }

  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

/** Layer exact scopes after translated legacy roles so migration overrides remain authoritative. */
export function resolveSyntaxScopeOverrides(
  syntax: CustomSyntaxColorsConfig | undefined,
  syntaxScopes: CustomSyntaxScopesConfig | undefined,
): CustomSyntaxScopesConfig | undefined {
  const legacyScopes = legacySyntaxColorsToScopes(syntax);
  if (!legacyScopes) {
    return syntaxScopes;
  }
  if (!syntaxScopes) {
    return legacyScopes;
  }

  return { ...legacyScopes, ...syntaxScopes };
}
