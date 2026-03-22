import type { AppTheme } from "../../themes";

/** Render the compact keyboard help overlay. */
export function HelpDialog({
  left,
  theme,
  width,
  onClose,
}: {
  left: number;
  theme: AppTheme;
  width: number;
  onClose: () => void;
}) {
  return (
    <box
      style={{
        position: "absolute",
        top: 3,
        left,
        width,
        height: 9,
        zIndex: 60,
        border: true,
        borderColor: theme.accent,
        backgroundColor: theme.panel,
        padding: 1,
        flexDirection: "column",
        gap: 1,
      }}
      onMouseUp={onClose}
    >
      <text fg={theme.text}>Keyboard</text>
      <text fg={theme.muted}>F10 menus arrows navigate menus Enter select Esc close menu</text>
      <text fg={theme.muted}>1 split 2 stack 0 auto t theme a notes l lines w wrap m meta</text>
      <text fg={theme.muted}>
        ↑/↓ line scroll space next page b previous page Home/End jump [ previous hunk ] next hunk
      </text>
      <text fg={theme.muted}>drag the Files/Diff divider with the mouse to resize the columns</text>
      <text fg={theme.muted}>/ focus filter Tab swap files/filter q quit</text>
      <text fg={theme.badgeNeutral}>click anywhere on this panel to close</text>
    </box>
  );
}
