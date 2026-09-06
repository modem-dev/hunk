import type { AppTheme } from "../../themes";
import { measureTextWidth, padText } from "../../lib/text";
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
  // Terminal cells, not code units: a shifted-character chord can be any glyph.
  const hintWidth = measureTextWidth(hint);
  const leftWidth = Math.max(0, width - hintWidth - (hintWidth > 0 ? 1 : 0));

  return (
    <box
      style={{ width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between" }}
    >
      <box style={{ width: leftWidth, height: 1 }}>
        <text fg={entry.disabled ? theme.muted : theme.text}>{padText(text, leftWidth)}</text>
      </box>
      {hint ? (
        <box style={{ width: hintWidth, height: 1 }}>
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
  terminalHeight = Number.MAX_SAFE_INTEGER,
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
  terminalHeight?: number;
  terminalWidth: number;
  theme: AppTheme;
  onHoverItem: (index: number) => void;
  onSelectItem: (entry: Extract<MenuEntry, { kind: "item" }>) => void;
}) {
  const clampedWidth = Math.max(1, Math.min(activeMenuWidth, terminalWidth - 2));
  const clampedLeft = Math.max(0, Math.min(activeMenuSpec.left, terminalWidth - clampedWidth));
  const visibleRowCount = Math.max(1, terminalHeight - top - 2);
  const windowStart = Math.max(
    0,
    Math.min(
      Math.max(0, activeMenuEntries.length - visibleRowCount),
      activeMenuItemIndex - Math.floor(visibleRowCount / 2),
    ),
  );
  const visibleEntries = activeMenuEntries.slice(windowStart, windowStart + visibleRowCount);

  return (
    <box
      style={{
        position: "absolute",
        top,
        left: clampedLeft,
        width: clampedWidth,
        height: visibleEntries.length + 2,
        zIndex: 40,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.panel,
        flexDirection: "column",
      }}
    >
      {visibleEntries.map((entry, offset) => {
        const index = windowStart + offset;
        return entry.kind === "separator" ? (
          <box
            key={`${activeMenuId}:separator:${index}`}
            style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}
          >
            <text fg={theme.border}>
              {padText("-".repeat(Math.max(0, clampedWidth - 4)), Math.max(0, clampedWidth - 2))}
            </text>
          </box>
        ) : (
          <box
            // Command ids are unique where labels need not be: two extensions
            // may both title a command "Refresh".
            key={`${activeMenuId}:${entry.commandId ?? `item-${index}`}`}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              backgroundColor:
                activeMenuItemIndex === index && !entry.disabled ? theme.accentMuted : theme.panel,
            }}
            onMouseOver={() => {
              if (!entry.disabled) onHoverItem(index);
            }}
            onMouseUp={() => {
              if (!entry.disabled) onSelectItem(entry);
            }}
          >
            {renderMenuLine(
              entry,
              Math.max(1, clampedWidth - 2),
              theme,
              activeMenuItemIndex === index && !entry.disabled,
            )}
          </box>
        );
      })}
    </box>
  );
}
