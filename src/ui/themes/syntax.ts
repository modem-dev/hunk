import { RGBA, SyntaxStyle } from "@opentui/core";
import { deriveSurfaces } from "./surfaces";
import type { AppTheme, SyntaxColors, ThemeBase } from "./types";

/** Build the syntax palette OpenTUI should use for in-terminal code rendering. */
export function createSyntaxStyle(colors: SyntaxColors) {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.default) },
    keyword: { fg: RGBA.fromHex(colors.keyword), bold: true },
    string: { fg: RGBA.fromHex(colors.string) },
    comment: { fg: RGBA.fromHex(colors.comment), italic: true },
    number: { fg: RGBA.fromHex(colors.number) },
    function: { fg: RGBA.fromHex(colors.function) },
    method: { fg: RGBA.fromHex(colors.function) },
    property: { fg: RGBA.fromHex(colors.property) },
    variable: { fg: RGBA.fromHex(colors.variable ?? colors.default) },
    constant: { fg: RGBA.fromHex(colors.number), bold: true },
    type: { fg: RGBA.fromHex(colors.type) },
    class: { fg: RGBA.fromHex(colors.type) },
    operator: { fg: RGBA.fromHex(colors.operator ?? colors.punctuation) },
    punctuation: { fg: RGBA.fromHex(colors.punctuation) },
  });
}

/** Lazily attach syntax colors so startup only pays for the active theme's token style. */
export function withLazySyntaxStyle(theme: ThemeBase, syntaxColors: SyntaxColors): AppTheme {
  let syntaxStyle: SyntaxStyle | null = null;

  return {
    ...theme,
    // Default to bordered chrome; the app overrides this from the user toggle.
    chrome: "bordered",
    surfaces: deriveSurfaces(theme),
    syntaxColors,
    get syntaxStyle() {
      syntaxStyle ??= createSyntaxStyle(syntaxColors);
      return syntaxStyle;
    },
  };
}
