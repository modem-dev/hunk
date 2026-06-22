import { BUNDLED_HIGHLIGHTER_THEME_IDS } from "../ui/lib/shikiThemes";

export const HUNK_DIFF_THEME_NAMES = BUNDLED_HIGHLIGHTER_THEME_IDS;

export type HunkDiffThemeName = (typeof HUNK_DIFF_THEME_NAMES)[number];
