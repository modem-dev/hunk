import { useEffect } from "react";
import type { AppTheme } from "../themes";
import { fitText } from "../lib/text";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { DocumentBrowserSnapshot } from "./controller";
import { mountedRowWindow, useRowViewport } from "./useRowViewport";

/** Paint a windowed filesystem tree with one shared activation path for every entry. */
export function DocumentTree({
  snapshot,
  theme,
  width,
  height,
  focused,
  onActivate,
}: {
  snapshot: DocumentBrowserSnapshot;
  theme: AppTheme;
  width: number;
  height: number;
  focused: boolean;
  onActivate: (key: string) => void;
}) {
  const viewport = useRowViewport(height, width);
  const selected = snapshot.rows.findIndex((row) => row.entry.key === snapshot.selectedKey);
  useEffect(() => {
    const scroll = viewport.ref.current;
    if (!scroll || selected < 0) return;
    if (selected < scroll.scrollTop) scroll.scrollTo(selected);
    else if (selected >= scroll.scrollTop + viewport.height)
      scroll.scrollTo(selected - viewport.height + 1);
  }, [selected, viewport.height, viewport.ref]);
  const window = mountedRowWindow(snapshot.rows.length, viewport.top, viewport.height);
  return (
    <scrollbox
      ref={viewport.ref}
      width="100%"
      height="100%"
      scrollY={true}
      focused={focused}
      // Semantic commands own keyboard navigation, including explicit unbindings.
      onKeyDown={(key) => key.preventDefault()}
    >
      {window.start ? <box height={window.start} /> : null}
      {snapshot.rows.slice(window.start, window.end).map(({ entry, depth }) => {
        const selected = entry.key === snapshot.selectedKey;
        const marker =
          entry.kind === "directory"
            ? snapshot.expanded.has(entry.key)
              ? "▼"
              : "▶"
            : entry.kind === "symlink"
              ? "↗"
              : " ";
        return (
          <box
            key={entry.key}
            height={1}
            width="100%"
            backgroundColor={selected ? theme.accentMuted : theme.panel}
            onMouseUp={() => onActivate(entry.key)}
          >
            <text
              fg={selected ? theme.accent : entry.ignored ? theme.muted : theme.text}
              wrapMode="none"
            >
              {fitText(
                `${"  ".repeat(Math.min(depth, 20))}${marker} ${sanitizeTerminalLine(entry.name)}${entry.status ? `  ${entry.status}` : ""}`,
                viewport.width,
              )}
            </text>
          </box>
        );
      })}
      {window.end < snapshot.rows.length ? (
        <box height={snapshot.rows.length - window.end} />
      ) : null}
    </scrollbox>
  );
}
