import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";
import { menuBarTitleWidth, responsiveMenuSpecs, type MenuId, type MenuSpec } from "./menu";

/** Render the top menu bar and the current changeset title. */
export function MenuBar({
  activeMenuId,
  menuSpecs,
  terminalWidth,
  theme,
  topTitle,
  onHoverMenu,
  onToggleMenu,
}: {
  activeMenuId: MenuId | null;
  menuSpecs: MenuSpec[];
  terminalWidth: number;
  theme: AppTheme;
  topTitle: string;
  onHoverMenu: (menuId: MenuId) => void;
  onToggleMenu: (menuId: MenuId) => void;
}) {
  const responsive = responsiveMenuSpecs(menuSpecs, terminalWidth);
  const visibleMenuSpecs = responsive.visible;
  const hiddenMenuIds = new Set(responsive.hidden.map((menu) => menu.id));
  const activeHiddenIndex = responsive.hidden.findIndex((menu) => menu.id === activeMenuId);
  const activeHiddenMenu =
    activeHiddenIndex >= 0 ? responsive.hidden[activeHiddenIndex] : undefined;
  const overflowTarget =
    activeHiddenIndex >= 0
      ? responsive.hidden[(activeHiddenIndex + 1) % responsive.hidden.length]
      : responsive.hidden[0];
  const overflowHoverTarget = activeHiddenMenu ?? responsive.hidden[0];
  const titleSpecs =
    responsive.overflowLeft === null
      ? visibleMenuSpecs
      : [
          ...visibleMenuSpecs,
          { id: "help" as const, left: responsive.overflowLeft, width: 3, label: "…" },
        ];
  const title = visibleMenuSpecs.length === 0 ? "F10 menu" : topTitle;
  return (
    // The outer row paints the app background so the bar keeps the same
    // one-column gutter the body panes have; only the inner band is chrome.
    <box
      style={{
        height: 1,
        backgroundColor: theme.background,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexGrow: 1,
          height: 1,
          backgroundColor: theme.panelAlt,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        {visibleMenuSpecs.map((menu) => {
          const active = activeMenuId === menu.id;
          return (
            <box
              key={menu.id}
              style={{
                width: menu.width,
                height: 1,
                backgroundColor: active ? theme.accentMuted : theme.panelAlt,
              }}
              onMouseUp={() => onToggleMenu(menu.id)}
              onMouseOver={() => onHoverMenu(menu.id)}
            >
              <text fg={active ? theme.text : theme.muted}>{` ${menu.label} `}</text>
            </box>
          );
        })}
        {overflowTarget && responsive.overflowLeft !== null ? (
          <box
            style={{
              width: 3,
              height: 1,
              backgroundColor:
                activeMenuId && hiddenMenuIds.has(activeMenuId)
                  ? theme.accentMuted
                  : theme.panelAlt,
            }}
            onMouseUp={() => onToggleMenu(overflowTarget.id)}
            onMouseOver={() => {
              if (activeMenuId && overflowHoverTarget) onHoverMenu(overflowHoverTarget.id);
            }}
          >
            <text fg={activeMenuId && hiddenMenuIds.has(activeMenuId) ? theme.text : theme.muted}>
              {" … "}
            </text>
          </box>
        ) : null}

        <box style={{ flexGrow: 1, height: 1, alignItems: "center", justifyContent: "flex-end" }}>
          <text
            fg={theme.muted}
          >{` ${fitText(title, menuBarTitleWidth(titleSpecs, terminalWidth))}`}</text>
        </box>
      </box>
    </box>
  );
}
