/**
 * Resolves the symbolic span vocabulary (`tone`, `attributes`) extensions and host surfaces
 * describe text with into OpenTUI paint values, only at paint time.
 *
 * Layout and measurement never touch a theme; this is the one mapping from a generic semantic
 * color to the active theme, shared by host-rendered file-view rows and the status line.
 */
import { TextAttributes } from "@opentui/core";
import type { ExtensionFileViewSpan } from "../../extension-api/types";
import type { AppTheme } from "../themes";

export type SymbolicTone = ExtensionFileViewSpan["tone"];
export type SymbolicTextAttribute = NonNullable<ExtensionFileViewSpan["attributes"]>[number];

/** Resolve a generic tone against the active theme; unknown or absent tones paint as body text. */
export function symbolicToneColor(tone: SymbolicTone, theme: AppTheme) {
  switch (tone) {
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "accent-muted":
      return theme.accentMuted;
    case "syntax":
      return theme.syntaxColors.default;
    case "added":
      return theme.fileNew;
    case "removed":
      return theme.fileDeleted;
    default:
      return theme.text;
  }
}

const ATTRIBUTE_BITS: Record<SymbolicTextAttribute, number> = {
  bold: TextAttributes.BOLD,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

/** Combine generic emphasis attributes into OpenTUI's terminal bitmask. */
export function symbolicTextAttributes(attributes: readonly SymbolicTextAttribute[] | undefined) {
  return (attributes ?? []).reduce(
    (combined, attribute) => combined | ATTRIBUTE_BITS[attribute],
    TextAttributes.NONE,
  );
}
