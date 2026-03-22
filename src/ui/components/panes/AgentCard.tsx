import { buildAgentPopoverContent } from "../../lib/agentPopover";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";

/** Render one framed floating agent note popover. */
export function AgentCard({
  locationLabel,
  noteCount = 1,
  noteIndex = 0,
  rationale,
  onClose,
  summary,
  theme,
  width,
}: {
  locationLabel: string;
  noteCount?: number;
  noteIndex?: number;
  rationale?: string;
  onClose?: () => void;
  summary: string;
  theme: AppTheme;
  width: number;
}) {
  const popover = buildAgentPopoverContent({
    summary,
    rationale,
    locationLabel,
    noteIndex,
    noteCount,
    width,
  });
  const titleWidth = Math.max(1, popover.innerWidth - (onClose ? 4 : 0));

  return (
    <box
      style={{
        width,
        height: popover.height,
        border: true,
        borderColor: theme.accent,
        backgroundColor: theme.panel,
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
          backgroundColor: theme.panel,
        }}
      >
        <text fg={theme.accent}>{padText(fitText(popover.title, titleWidth), titleWidth)}</text>
        {onClose ? (
          <box onMouseUp={onClose} style={{ backgroundColor: theme.panel }}>
            <text fg={theme.muted}>[x]</text>
          </box>
        ) : null}
      </box>

      {popover.summaryLines.map((line, index) => (
        <box
          key={`summary:${index}`}
          style={{ width: "100%", height: 1, backgroundColor: theme.panel }}
        >
          <text fg={theme.text}>{padText(line, popover.innerWidth)}</text>
        </box>
      ))}

      {popover.rationaleLines.length > 0 ? (
        <>
          <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
            <text fg={theme.text}>{" ".repeat(popover.innerWidth)}</text>
          </box>
          {popover.rationaleLines.map((line, index) => (
            <box
              key={`rationale:${index}`}
              style={{ width: "100%", height: 1, backgroundColor: theme.panel }}
            >
              <text fg={theme.muted}>{padText(line, popover.innerWidth)}</text>
            </box>
          ))}
        </>
      ) : null}

      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
        <text fg={theme.text}>{" ".repeat(popover.innerWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
        <text fg={theme.muted}>{padText(popover.footer, popover.innerWidth)}</text>
      </box>
    </box>
  );
}
