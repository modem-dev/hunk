import type { AppTheme } from "../../themes";
import { blendHex } from "../../lib/color";
import { padText } from "../../lib/text";
import { chromeSurfaceBg, overlaySurfaceStyle } from "./chromeSurface";
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
  terminalWidth: number;
  theme: AppTheme;
  onHoverItem: (index: number) => void;
  onSelectItem: (entry: Extract<MenuEntry, { kind: "item" }>) => void;
}) {
  const clampedWidth = Math.min(activeMenuWidth, Math.max(22, terminalWidth - 2));
  const clampedLeft = Math.max(1, Math.min(activeMenuSpec.left, terminalWidth - clampedWidth - 1));
  const borderless = theme.chrome === "borderless";
  // Bordered menus add 2 rows for the top/bottom rule; borderless ones have no border, so the
  // box must hug its entries or it trails empty band rows.
  const dropdownHeight = activeMenuEntries.length + (borderless ? 0 : 2);
  // A faint rule keeps separators legible against the filled band without reintroducing chrome.
  const separatorFg = borderless
    ? blendHex(theme.muted, chromeSurfaceBg(theme, "overlay"), 0.5)
    : theme.border;

  return (
    <box
      style={{
        position: "absolute",
        top: 1,
        left: clampedLeft,
        width: clampedWidth,
        height: dropdownHeight,
        zIndex: 40,
        ...overlaySurfaceStyle(theme, theme.border),
        flexDirection: "column",
      }}
    >
      {activeMenuEntries.map((entry, index) =>
        entry.kind === "separator" ? (
          <box
            key={`${activeMenuId}:separator:${index}`}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              backgroundColor: chromeSurfaceBg(theme, "overlay"),
            }}
          >
            {/* Both modes rule off groups; borderless uses a fainter line so it stays subtle. */}
            <text fg={separatorFg}>{padText("-".repeat(clampedWidth - 4), clampedWidth - 2)}</text>
          </box>
        ) : (
          <box
            key={`${activeMenuId}:${entry.label}`}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              backgroundColor:
                activeMenuItemIndex === index
                  ? chromeSurfaceBg(theme, "selection")
                  : chromeSurfaceBg(theme, "overlay"),
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
