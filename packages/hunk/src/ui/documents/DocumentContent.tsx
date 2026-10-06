import type { ComponentProps } from "react";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { AppTheme } from "../themes";
import { fitText } from "../lib/text";
import { DocumentPane } from "./DocumentPane";
import { DocumentTree } from "./DocumentTree";
import type { DocumentBrowserSnapshot } from "./controller";

/** Resolve a display hint without treating document identity as a filesystem path. */
function documentHint(snapshot: DocumentBrowserSnapshot, fallback: string) {
  return snapshot.documentEntry?.displayPath ?? snapshot.documentEntry?.name ?? fallback;
}

/** Place the directory tree beside the complete document while retaining independent focus. */
export function DocumentContent({
  snapshot,
  sidebar,
  treeWidth,
  terminalWidth,
  treeFocused,
  overlay,
  pane,
  onFocus,
  onActivate,
}: {
  snapshot: DocumentBrowserSnapshot;
  sidebar: boolean;
  treeWidth: number;
  terminalWidth: number;
  treeFocused: boolean;
  overlay: boolean;
  pane: Omit<
    ComponentProps<typeof DocumentPane>,
    "document" | "documentKey" | "pathHint" | "width" | "focused"
  >;
  onFocus: (focus: "tree" | "document") => void;
  onActivate: (key: string) => void;
}) {
  const { theme, height } = pane;
  return (
    <box flexGrow={1} flexDirection="row">
      {sidebar ? (
        <box
          width={treeWidth}
          height="100%"
          backgroundColor={theme.panel}
          onMouseDown={() => onFocus("tree")}
        >
          <DocumentTree
            snapshot={snapshot}
            theme={theme}
            width={treeWidth}
            height={height}
            focused={treeFocused && !overlay}
            onActivate={(key) => {
              onFocus("tree");
              onActivate(key);
            }}
          />
        </box>
      ) : null}
      {sidebar ? <box width={1} height="100%" backgroundColor={theme.border} /> : null}
      <box
        flexGrow={1}
        height="100%"
        flexDirection="column"
        onMouseDown={() => onFocus("document")}
      >
        <text height={1} fg={theme.accent}>
          {fitText(
            ` ${sanitizeTerminalLine(documentHint(snapshot, "Complete document"))}`,
            Math.max(1, terminalWidth - treeWidth - 1),
          )}
        </text>
        <DocumentPane
          {...pane}
          document={snapshot.document}
          documentKey={snapshot.documentKey}
          pathHint={documentHint(snapshot, "document")}
          width={Math.max(1, terminalWidth - treeWidth - (sidebar ? 1 : 0))}
          focused={!treeFocused && !overlay}
        />
      </box>
    </box>
  );
}

/** Show transient notices before source notices, keymap issues and the focused-surface summary. */
export function DocumentStatusBar({
  snapshot,
  notice,
  keymapIssue,
  treeFocused,
  width,
  theme,
}: {
  snapshot: DocumentBrowserSnapshot;
  notice: string | null;
  keymapIssue: string | undefined;
  treeFocused: boolean;
  width: number;
  theme: AppTheme;
}) {
  const fallback = `${treeFocused ? "Tree" : "Document"} · read-only · ${snapshot.showExcluded ? "hidden/ignored shown" : "hidden/ignored hidden"}`;
  const text = notice ?? snapshot.notice ?? keymapIssue ?? fallback;
  return (
    <text height={1} fg={theme.muted}>
      {fitText(` ${sanitizeTerminalLine(text)}`, width)}
    </text>
  );
}
