import { fitText } from "../../lib/text";
import {
  renderMarkdownRows,
  wrapStyledSpans,
  type MarkdownRow,
  type MarkdownSpan,
} from "../../markdown/markdownRows";
import type { AppTheme } from "../../themes";
import { ModalFrame } from "./ModalFrame";

/**
 * One painted line in the overview body. Prose rows expand into one or more
 * `spans` lines (wrapped to the width after their prefix); structural rows map
 * to `blank`/`rule`.
 */
type VisualLine =
  | { kind: "blank" }
  | { kind: "rule" }
  | {
      kind: "spans";
      prefix: string;
      prefixColor: string;
      /** Overrides per-span color (used so all heading spans share one color). */
      spanColor?: string;
      spans: MarkdownSpan[];
    };

/** Pick a foreground color for an inline span from the theme. */
function spanColor(span: MarkdownSpan, theme: AppTheme): string {
  switch (span.kind) {
    case "code":
      return theme.accent;
    case "link":
      return theme.accent;
    default:
      return theme.text;
  }
}

/** Left prefix for a block row (bullets, ordinals, quote bar, heading depth), indented by nesting level. */
function rowPrefix(row: MarkdownRow): string {
  const indent = "  ".repeat(Math.max(0, row.level ?? 0));
  switch (row.kind) {
    case "heading":
      // Show the markdown hashes so heading depth (h1-h6) is visually distinct.
      return `${"#".repeat(Math.min(6, Math.max(1, row.level ?? 1)))} `;
    case "bullet":
      return `${indent}• `;
    case "ordered":
      return `${indent}${row.ordinal ?? 1}. `;
    case "quote":
      return "│ ";
    case "code":
      return "  ";
    default:
      return "";
  }
}

/**
 * Expand one logical markdown row into the visual lines to paint, wrapping prose
 * spans to the width left after the row's prefix. Code lines are truncated rather
 * than word-wrapped; continuation lines keep the quote bar but otherwise indent.
 */
function toVisualLines(row: MarkdownRow, bodyWidth: number, theme: AppTheme): VisualLine[] {
  if (row.kind === "blank") {
    return [{ kind: "blank" }];
  }
  if (row.kind === "rule") {
    return [{ kind: "rule" }];
  }

  const prefix = rowPrefix(row);
  const available = Math.max(1, bodyWidth - prefix.length);

  if (row.kind === "code") {
    const text = row.spans.map((span) => span.text).join("");
    return [
      {
        kind: "spans",
        prefix,
        prefixColor: theme.muted,
        spanColor: theme.muted,
        spans: [{ text: fitText(text, available), kind: "text" }],
      },
    ];
  }

  const isQuote = row.kind === "quote";
  const prefixColor = isQuote ? theme.border : theme.muted;
  // Headings paint every span in one accent color; other rows color per span kind.
  const headingSpanColor = row.kind === "heading" ? theme.accent : undefined;
  const continuationPrefix = isQuote ? prefix : " ".repeat(prefix.length);

  return wrapStyledSpans(row.spans, available).map((spans, lineIndex) => ({
    kind: "spans" as const,
    prefix: lineIndex === 0 ? prefix : continuationPrefix,
    prefixColor,
    spanColor: headingSpanColor,
    spans,
  }));
}

/** Render the changeset overview (title + markdown description) as a modal overlay. */
export function OverviewDialog({
  title,
  description,
  summary,
  terminalHeight,
  terminalWidth,
  theme,
  onClose,
}: {
  title?: string;
  description?: string;
  summary?: string;
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onClose: () => void;
}) {
  const width = Math.min(96, Math.max(60, terminalWidth - 8));
  const bodyWidth = Math.max(1, width - 4);
  // The overview prefers the agent's markdown description, falling back to the
  // legacy plain-text summary when no description was provided.
  const bodyMarkdown = description ?? summary;
  const rows = bodyMarkdown ? renderMarkdownRows(bodyMarkdown, bodyWidth) : [];
  const hasContent = Boolean(title) || rows.length > 0;

  // Flatten logical rows into the visual lines we actually paint, wrapping prose
  // spans to the width left after the row's prefix. Doing this up front lets the
  // modal size itself to the real line count instead of one-line-per-row.
  const visualLines = rows.flatMap((row) => toVisualLines(row, bodyWidth, theme));

  // Title takes 2 rows (text + blank spacer); empty state takes 1; otherwise the
  // visual line count.
  const contentRowCount = (title ? 2 : 0) + (hasContent ? visualLines.length : 1);
  // ModalFrame contributes border rows, title row, padding, and one blank spacer row.
  const modalFrameChromeRowCount = 6;
  const requiredHeight = contentRowCount + modalFrameChromeRowCount;
  const modalHeight = Math.min(requiredHeight, Math.max(10, terminalHeight - 2));
  const shouldScroll = modalHeight < requiredHeight;

  const body = (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {title ? (
        <>
          <box style={{ width: "100%", height: 1 }}>
            <text fg={theme.accent}>{fitText(title, bodyWidth)}</text>
          </box>
          <box style={{ width: "100%", height: 1 }} />
        </>
      ) : null}
      {!hasContent ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>{fitText("No description provided.", bodyWidth)}</text>
        </box>
      ) : null}
      {visualLines.map((line, index) => {
        if (line.kind === "blank") {
          return <box key={`line:${index}`} style={{ width: "100%", height: 1 }} />;
        }
        if (line.kind === "rule") {
          return (
            <box key={`line:${index}`} style={{ width: "100%", height: 1 }}>
              <text fg={theme.border}>{"─".repeat(bodyWidth)}</text>
            </box>
          );
        }
        // Render the whole line as one <text> with colored <span> children.
        // A single text node preserves the spaces at span boundaries, which
        // separate <text> nodes in a flex row would trim away.
        return (
          <box key={`line:${index}`} style={{ width: "100%", height: 1 }}>
            <text>
              {line.prefix ? <span fg={line.prefixColor}>{line.prefix}</span> : null}
              {line.spans.map((span, spanIndex) => (
                <span
                  key={`span:${index}:${spanIndex}`}
                  fg={line.spanColor ?? spanColor(span, theme)}
                >
                  {span.text}
                </span>
              ))}
            </text>
          </box>
        );
      })}
    </box>
  );

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title="Overview"
      width={width}
      onClose={onClose}
    >
      {shouldScroll ? (
        <scrollbox focused={false} height="100%" scrollY={true} width="100%">
          {body}
        </scrollbox>
      ) : (
        body
      )}
    </ModalFrame>
  );
}
