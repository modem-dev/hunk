import { For } from "solid-js";
import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";
import type { MenuId, MenuSpec } from "./menu";

/** Render the top menu bar and the current changeset title. */
export function MenuBar(props: {
  activeMenuId: MenuId | null;
  menuSpecs: MenuSpec[];
  terminalWidth: number;
  theme: AppTheme;
  topTitle: string;
  onHoverMenu: (menuId: MenuId) => void;
  onToggleMenu: (menuId: MenuId) => void;
}) {
  return (
    <box
      style={{
        height: 1,
        backgroundColor: props.theme.panelAlt,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <For each={props.menuSpecs}>
        {(menu) => {
          const active = () => props.activeMenuId === menu.id;
          return (
            <box
              style={{
                width: menu.width,
                height: 1,
                backgroundColor: active() ? props.theme.accentMuted : props.theme.panelAlt,
              }}
              onMouseUp={() => props.onToggleMenu(menu.id)}
              onMouseOver={() => props.onHoverMenu(menu.id)}
            >
              <text fg={active() ? props.theme.text : props.theme.muted}>{` ${menu.label} `}</text>
            </box>
          );
        }}
      </For>

      <box style={{ flexGrow: 1, height: 1, alignItems: "center", justifyContent: "flex-end" }}>
        <text
          fg={props.theme.muted}
        >{` ${fitText(props.topTitle, Math.max(0, props.terminalWidth - 41))}`}</text>
      </box>
    </box>
  );
}
