/**
 * Draws the one-row status line: persistent items, the inline prompt when one is open, and the
 * keyboard-mode badge.
 *
 * Both `App` and `LogApp` mount this over their own store. The component owns the focused
 * OpenTUI `<input>` and the badge's click-to-exit; it decides nothing about what is on the row.
 * Placement comes from `layoutStatusLine`, so what is dropped or truncated on a narrow terminal is
 * deterministic and tested without a renderer.
 */
import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { isEscapeKey } from "../lib/keyboard";
import { symbolicTextAttributes, symbolicToneColor } from "../lib/symbolicSpans";
import type { AppTheme } from "../themes";
import { STATUS_LINE_PADDING, layoutStatusLine, type PlacedStatusItem } from "./layout";
import type { StatusLineSnapshot } from "./types";

/** Report whether the row has anything to show, so the host can drop it entirely when idle. */
export function statusLineHasContent(snapshot: StatusLineSnapshot, badge: string | null) {
  return (
    snapshot.prompt !== null ||
    Boolean(badge) ||
    snapshot.items.some((item) => item.spans.some((span) => span.text.length > 0))
  );
}

function PlacedItems({ items, theme }: { items: readonly PlacedStatusItem[]; theme: AppTheme }) {
  return items.map((item, index) => (
    <box key={item.id} style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
      {index > 0 ? <text fg={theme.muted}>{"  "}</text> : null}
      {item.spans.map((span, spanIndex) => (
        <text
          key={spanIndex}
          fg={symbolicToneColor(span.tone, theme)}
          attributes={symbolicTextAttributes(span.attributes)}
        >
          {span.text}
        </text>
      ))}
    </box>
  ));
}

export function StatusLine({
  badge,
  snapshot,
  terminalWidth,
  theme,
  onCloseMenu,
  onExitMode,
  onPromptCancel,
  onPromptInput,
  onPromptSubmit,
}: {
  /** Keyboard-mode badge text, or `null` when no mode is active. */
  badge: string | null;
  snapshot: StatusLineSnapshot;
  terminalWidth: number;
  theme: AppTheme;
  onCloseMenu?: () => void;
  onExitMode?: () => void;
  onPromptCancel: (id: number) => void;
  onPromptInput: (id: number, value: string) => void;
  onPromptSubmit: (id: number) => void;
}) {
  const prompt = snapshot.prompt;
  // Cheap enough to run per render: a handful of items and one row of cells.
  const layout = layoutStatusLine({
    items: snapshot.items,
    prompt: prompt ? { prefix: prompt.prefix, attribution: prompt.attribution } : null,
    badge,
    width: terminalWidth,
  });

  return (
    <box
      style={{
        height: 1,
        backgroundColor: theme.panelAlt,
        paddingLeft: STATUS_LINE_PADDING,
        paddingRight: STATUS_LINE_PADDING,
        alignItems: "center",
        flexDirection: "row",
      }}
      onMouseUp={onCloseMenu}
    >
      <box
        style={{
          height: 1,
          flexGrow: 1,
          overflow: "hidden",
          alignItems: "center",
          flexDirection: "row",
        }}
      >
        {prompt && layout.prompt ? (
          <>
            {layout.prompt.attribution ? (
              <text fg={theme.badgeNeutral}>{`${layout.prompt.attribution} `}</text>
            ) : null}
            {layout.prompt.prefix ? (
              <text fg={theme.badgeNeutral}>{`${layout.prompt.prefix} `}</text>
            ) : null}
            <input
              width={layout.prompt.inputWidth}
              value={prompt.value}
              placeholder={prompt.placeholder}
              focused={true}
              onInput={(value) => onPromptInput(prompt.id, value)}
              onSubmit={() => onPromptSubmit(prompt.id)}
              onKeyDown={(key) => {
                if (!isEscapeKey(key)) return;
                key.preventDefault();
                key.stopPropagation();
                // Two-step Escape: clear a non-empty buffer first, then leave the prompt.
                if (prompt.value.length > 0) {
                  onPromptInput(prompt.id, "");
                  return;
                }
                onPromptCancel(prompt.id);
              }}
            />
          </>
        ) : (
          <PlacedItems items={layout.left} theme={theme} />
        )}
      </box>
      {layout.right.length > 0 ? (
        <box style={{ height: 1, flexDirection: "row", flexShrink: 0, marginLeft: 2 }}>
          <PlacedItems items={layout.right} theme={theme} />
        </box>
      ) : null}
      {layout.badge ? (
        <box
          style={{
            height: 1,
            width: layout.badge.width,
            overflow: "hidden",
            backgroundColor: theme.badgeNeutral,
            marginLeft: 1,
            flexShrink: 0,
          }}
          onMouseUp={(event: TuiMouseEvent) => {
            event.stopPropagation();
            onExitMode?.();
          }}
        >
          <text fg={theme.panelAlt}>{` ${layout.badge.text} `}</text>
        </box>
      ) : null}
    </box>
  );
}
