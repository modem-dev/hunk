import { Match, Switch } from "solid-js";
import { isEscapeKey } from "../../lib/keyboard";
import type { AppTheme } from "../../themes";

/** Render the active file filter input or current filter summary. */
export function StatusBar(props: {
  filter: string;
  filterFocused: boolean;
  noticeText?: string;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu: () => void;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
}) {
  return (
    <box
      style={{
        height: 1,
        backgroundColor: props.theme.panelAlt,
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        flexDirection: "row",
      }}
      onMouseUp={props.onCloseMenu}
    >
      <Switch fallback={<text fg={props.theme.muted}>{props.noticeText ?? ""}</text>}>
        <Match when={props.filterFocused}>
          <text fg={props.theme.badgeNeutral}>filter:</text>
          <box style={{ width: 1, height: 1 }}>
            <text fg={props.theme.muted}> </text>
          </box>
          <input
            width={Math.max(12, props.terminalWidth - 11)}
            value={props.filter}
            placeholder="type to filter files"
            focused={true}
            onInput={props.onFilterInput}
            onSubmit={props.onFilterSubmit}
            onKeyDown={(key) => {
              if (!isEscapeKey(key)) {
                return;
              }

              key.preventDefault();
              key.stopPropagation();

              if (props.filter.length > 0) {
                props.onFilterInput("");
                return;
              }

              props.onFilterSubmit();
            }}
          />
        </Match>
        <Match when={props.filter.length > 0}>
          <text fg={props.theme.muted}>{`filter=${props.filter}`}</text>
        </Match>
      </Switch>
    </box>
  );
}
