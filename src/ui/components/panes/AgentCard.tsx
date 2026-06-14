import { For, mergeProps, Show } from "solid-js";
import { buildAgentPopoverContent } from "../../lib/agentPopover";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render one framed floating agent note popover. */
export function AgentCard(rawProps: {
  locationLabel: string;
  noteCount?: number;
  noteIndex?: number;
  rationale?: string;
  onClose?: () => void;
  summary: string;
  theme: AppTheme;
  width: number;
  author?: string;
}) {
  const props = mergeProps({ noteCount: 1, noteIndex: 0 }, rawProps);
  const popover = () =>
    buildAgentPopoverContent({
      summary: props.summary,
      rationale: props.rationale,
      locationLabel: props.locationLabel,
      noteIndex: props.noteIndex,
      noteCount: props.noteCount,
      width: props.width,
      author: props.author,
    });
  const titleWidth = () => Math.max(1, popover().innerWidth - (props.onClose ? 4 : 0));

  return (
    <box
      style={{
        width: props.width,
        height: popover().height,
        border: true,
        borderColor: props.theme.accent,
        backgroundColor: props.theme.panel,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        flexDirection: "column",
      }}
    >
      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
          backgroundColor: props.theme.panel,
        }}
      >
        <text fg={props.theme.accent}>
          {padText(fitText(popover().title, titleWidth()), titleWidth())}
        </text>
        <Show when={props.onClose}>
          <box onMouseUp={props.onClose} style={{ backgroundColor: props.theme.panel }}>
            <text fg={props.theme.muted}>[x]</text>
          </box>
        </Show>
      </box>

      <For each={popover().summaryLines}>
        {(line) => (
          <box style={{ width: "100%", height: 1, backgroundColor: props.theme.panel }}>
            <text fg={props.theme.text}>{padText(line, popover().innerWidth)}</text>
          </box>
        )}
      </For>

      <Show when={popover().rationaleLines.length > 0}>
        <box style={{ width: "100%", height: 1, backgroundColor: props.theme.panel }}>
          <text fg={props.theme.text}>{" ".repeat(popover().innerWidth)}</text>
        </box>
        <For each={popover().rationaleLines}>
          {(line) => (
            <box style={{ width: "100%", height: 1, backgroundColor: props.theme.panel }}>
              <text fg={props.theme.muted}>{padText(line, popover().innerWidth)}</text>
            </box>
          )}
        </For>
      </Show>

      <box style={{ width: "100%", height: 1, backgroundColor: props.theme.panel }}>
        <text fg={props.theme.text}>{" ".repeat(popover().innerWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1, backgroundColor: props.theme.panel }}>
        <text fg={props.theme.muted}>{padText(popover().footer, popover().innerWidth)}</text>
      </box>
    </box>
  );
}
