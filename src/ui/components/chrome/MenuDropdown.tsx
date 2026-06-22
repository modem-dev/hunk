import type { AppTheme } from "../../themes";
import { padText } from "../../lib/text";
import type { MenuEntry, MenuId, MenuSpec } from "./menu";

/** Render one actionable menu line with an optional keyboard hint. */
function renderMenuLine(
  entry: Extract<MenuEntry, { kind: "item" }>,
  width: number,
  theme: AppTheme,
  selected: boolean,
) {
  const text =
    entry.checked === undefined
      ? `  ${entry.label}`
      : `${entry.checked ? "[x]" : "[ ]"} ${entry.label}`;
  const hint = entry.hint ? entry.hint : "";
  const leftWidth = Math.max(0, width - hint.length - (hint.length > 0 ? 1 : 0));

  return (
    <box
      style={{ width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between" }}
    >
      <box style={{ width: leftWidth, height: 1 }}>
        <text fg={theme.text}>{padText(text, leftWidth)}</text>
      </box>
      {hint ? (
        <box style={{ width: hint.length, height: 1 }}>
          <text fg={selected ? theme.text : theme.muted}>{hint}</text>
        </box>
      ) : null}
    </box>
  );
}

/** Render the dropdown for the currently active top-level menu. */
export function MenuDropdown({
  activeMenuId,
  activeMenuEntries,
  activeMenuItemIndex,
  activeMenuSpec,
  activeMenuWidth,
  top = 1,
  terminalWidth,
  theme,
  onHoverItem,
  onSelectItem,
}: {
  activeMenuId: MenuId;
  activeMenuEntries: MenuEntry[];
  activeMenuItemIndex: number;
  activeMenuSpec: MenuSpec;
  activeMenuWidth: number;
  top?: number;
  terminalWidth: number;
  theme: AppTheme;
  onHoverItem: (index: number) => void;
  onSelectItem: (entry: Extract<MenuEntry, { kind: "item" }>) => void;
}) {
  const clampedWidth = Math.min(activeMenuWidth, Math.max(22, terminalWidth - 2));
  const clampedLeft = Math.max(1, Math.min(activeMenuSpec.left, terminalWidth - clampedWidth - 1));

  return (
    <box
      style={{
        position: "absolute",
        top,
        left: clampedLeft,
        width: clampedWidth,
        height: activeMenuEntries.length + 2,
        zIndex: 40,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.panel,
        flexDirection: "column",
      }}
    >
      {activeMenuEntries.map((entry, index) =>
        entry.kind === "separator" ? (
          <box
            key={`${activeMenuId}:separator:${index}`}
            style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}
          >
            <text fg={theme.border}>{padText("-".repeat(clampedWidth - 4), clampedWidth - 2)}</text>
          </box>
        ) : (
          <box
            key={`${activeMenuId}:${entry.label}`}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              backgroundColor: activeMenuItemIndex === index ? theme.accentMuted : theme.panel,
            }}
            onMouseOver={() => onHoverItem(index)}
            onMouseUp={() => onSelectItem(entry)}
          >
            {renderMenuLine(entry, clampedWidth - 2, theme, activeMenuItemIndex === index)}
          </box>
        ),
      )}
    </box>
  );
}
