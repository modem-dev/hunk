import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/**
 * Horizontal boundary between stacked sections (e.g. file blocks). Draws a rule
 * glyph in bordered mode; renders nothing in borderless mode, where the adjacent
 * section-header band carries the separation instead.
 */
export function ChromeSeparator({ theme, width }: { theme: AppTheme; width: number }) {
  if (theme.chrome === "borderless") {
    return null;
  }

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
    >
      <text fg={theme.border}>{fitText("─".repeat(width), width)}</text>
    </box>
  );
}
