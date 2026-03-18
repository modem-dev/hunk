import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";

/** Render one inline agent note card beside the diff rows it explains. */
export function AgentCard({
  locationLabel,
  rationale,
  onClose,
  summary,
  theme,
  width,
}: {
  locationLabel: string;
  rationale?: string;
  onClose?: () => void;
  summary: string;
  theme: AppTheme;
  width: number;
}) {
  return (
    <box
      style={{
        width,
        border: true,
        borderColor: theme.accentMuted,
        backgroundColor: theme.panelAlt,
        padding: 1,
        flexDirection: "column",
        gap: 1,
      }}
    >
      <box
        style={{
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <text fg={theme.accent}>{fitText(locationLabel, Math.max(1, width - (onClose ? 6 : 2)))}</text>
        {onClose ? (
          <box onMouseUp={onClose}>
            <text fg={theme.muted}>[x]</text>
          </box>
        ) : null}
      </box>
      <text fg={theme.text}>{summary}</text>
      {rationale ? <text fg={theme.muted}>{rationale}</text> : null}
    </box>
  );
}
