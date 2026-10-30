import type {
  CustomThemeConfig,
  NamedCustomThemeConfig,
} from "../../packages/hunk/src/extension-api/types";

/**
 * Name one custom palette so it can be passed to the theme APIs, which take the
 * full list of custom themes a session resolved.
 */
export function createTestCustomThemes(
  theme: CustomThemeConfig,
  id = "custom",
): NamedCustomThemeConfig[] {
  return [{ id, ...theme }];
}
