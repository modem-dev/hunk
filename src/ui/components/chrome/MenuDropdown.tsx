import { For, Show } from "solid-js";
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
      <Show when={hint}>
        <box style={{ width: hint.length, height: 1 }}>
          <text fg={selected ? theme.text : theme.muted}>{hint}</text>
        </box>
      </Show>
    </box>
  );
}

/** Render the dropdown for the currently active top-level menu. */
export function MenuDropdown(props: {
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
  const clampedWidth = () => Math.min(props.activeMenuWidth, Math.max(22, props.terminalWidth - 2));
  const clampedLeft = () =>
    Math.max(1, Math.min(props.activeMenuSpec.left, props.terminalWidth - clampedWidth() - 1));

  return (
    <box
      style={{
        position: "absolute",
        top: 1,
        left: clampedLeft(),
        width: clampedWidth(),
        height: props.activeMenuEntries.length + 2,
        zIndex: 40,
        border: true,
        borderColor: props.theme.border,
        backgroundColor: props.theme.panel,
        flexDirection: "column",
      }}
    >
      <For each={props.activeMenuEntries}>
        {(entry, index) => (
          <Show
            when={entry.kind === "separator"}
            fallback={
              <box
                style={{
                  height: 1,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "row",
                  backgroundColor:
                    props.activeMenuItemIndex === index()
                      ? props.theme.accentMuted
                      : props.theme.panel,
                }}
                onMouseOver={() => props.onHoverItem(index())}
                onMouseUp={() => props.onSelectItem(entry as Extract<MenuEntry, { kind: "item" }>)}
              >
                {renderMenuLine(
                  entry as Extract<MenuEntry, { kind: "item" }>,
                  clampedWidth() - 2,
                  props.theme,
                  props.activeMenuItemIndex === index(),
                )}
              </box>
            }
          >
            <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
              <text fg={props.theme.border}>
                {padText("-".repeat(clampedWidth() - 4), clampedWidth() - 2)}
              </text>
            </box>
          </Show>
        )}
      </For>
    </box>
  );
}
