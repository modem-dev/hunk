import { createCliRenderer } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  HunkDiffBody,
  HunkDiffFileHeader,
  HunkFileNav,
  HunkReviewStream,
  createHunkDiffFilesFromPatch,
  type HunkDiffLayout,
} from "../../src/opentui";
import { fitText, padText } from "../../src/ui/lib/text";

const PATCH = `diff --git a/src/search.ts b/src/search.ts
--- a/src/search.ts
+++ b/src/search.ts
@@ -1,8 +1,18 @@
 export interface Command {
   id: string;
   label: string;
   keywords?: string[];
 }
 
 export function searchCommands(commands: Command[], query: string) {
-  const needle = query.trim().toLowerCase();
-  return commands.filter((command) => command.label.toLowerCase().includes(needle));
+  const needle = normalizeQuery(query);
+  if (!needle) {
+    return commands;
+  }
+
+  return commands
+    .map((command) => ({ command, score: scoreCommand(command, needle) }))
+    .filter((result) => result.score > 0)
+    .sort((left, right) => right.score - left.score)
+    .map((result) => result.command);
 }
+
+function normalizeQuery(value: string) {
+  return value.trim().toLowerCase();
+}
+
+function scoreCommand(command: Command, needle: string) {
+  return command.label.toLowerCase().startsWith(needle) ? 3 : 0;
+}
diff --git a/src/commands.ts b/src/commands.ts
--- a/src/commands.ts
+++ b/src/commands.ts
@@ -1,7 +1,8 @@
 import type { Command } from "./search";
 
 export const commands: Command[] = [
   { id: "open-workspace", label: "Open workspace", keywords: ["project", "folder"] },
   { id: "toggle-sidebar", label: "Toggle sidebar", keywords: ["files", "panel"] },
   { id: "next-hunk", label: "Next hunk", keywords: ["jump", "change"] },
-  { id: "open-help", label: "Open help", keywords: ["keyboard", "shortcuts"] },
+  { id: "open-help", label: "Open help", keywords: ["keyboard", "shortcuts", "short cuts"] },
+  { id: "copy-command", label: "Copy command id", keywords: ["clipboard", "copy"] },
 ];
`;

function WindowFrame({
  children,
  height,
  title,
  width,
}: {
  children: ReactNode;
  height?: number | string;
  title: string;
  width: number | string;
}) {
  const numericWidth = typeof width === "number" ? width : 60;
  const titleText = ` ${title} `;

  return (
    <box
      style={{
        width,
        height,
        border: true,
        borderColor: "#284264",
        backgroundColor: "#0e1b2e",
        flexDirection: "column",
      }}
    >
      <box style={{ width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 }}>
        <text fg="#7fd1ff">{fitText(titleText, Math.max(1, numericWidth - 2))}</text>
      </box>
      <box
        style={{
          width: "100%",
          flexGrow: 1,
          paddingLeft: 1,
          paddingRight: 1,
          paddingBottom: 1,
        }}
      >
        {children}
      </box>
    </box>
  );
}

/** Small custom OpenTUI app assembled from Hunk's exported primitives. */
function PrimitivesDemoApp({ onQuit }: { onQuit: () => void }) {
  const terminal = useTerminalDimensions();
  const files = useMemo(() => createHunkDiffFilesFromPatch(PATCH, "primitives-demo"), []);
  const [layout, setLayout] = useState<HunkDiffLayout>("split");
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id ?? "");
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? files[0];
  const sidebarWidth = Math.min(34, Math.max(24, Math.floor(terminal.width * 0.28)));
  const gap = 1;
  const mainWidth = Math.max(44, terminal.width - sidebarWidth - gap - 2);
  const contentHeight = Math.max(10, terminal.height - 4);
  const headerWindowHeight = 4;
  const remainingMainHeight = Math.max(8, contentHeight - headerWindowHeight - gap);
  const bodyWindowHeight = Math.max(6, Math.floor(remainingMainHeight * 0.52));
  const streamWindowHeight = Math.max(6, remainingMainHeight - bodyWindowHeight - gap);

  useKeyboard((key: KeyEvent) => {
    if (key.name === "q" || key.name === "escape") {
      onQuit();
      return;
    }

    if (key.name === "1") {
      setLayout("split");
      return;
    }

    if (key.name === "2") {
      setLayout("stack");
      return;
    }

    if (key.name === "tab" && files.length > 1) {
      const currentIndex = files.findIndex((file) => file.id === selectedFileId);
      const nextFile = files[(currentIndex + 1) % files.length] ?? files[0];
      setSelectedFileId(nextFile?.id ?? "");
    }
  });

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#08111f",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
      }}
    >
      <box style={{ width: "100%", height: 1, backgroundColor: "#13243a" }}>
        <text fg="#eef4ff">
          {padText(
            fitText(
              " Hunk primitives as app windows — q quit · Tab next file · 1 split · 2 stack ",
              Math.max(1, terminal.width - 2),
            ),
            Math.max(1, terminal.width - 2),
          )}
        </text>
      </box>
      <box style={{ height: 1 }} />
      <box style={{ width: "100%", height: contentHeight, flexDirection: "row" }}>
        <WindowFrame title="HunkFileNav" width={sidebarWidth} height={contentHeight}>
          <scrollbox
            width="100%"
            height="100%"
            scrollY={true}
            viewportCulling={true}
            focused={false}
          >
            <HunkFileNav
              files={files}
              selectedFileId={selectedFile?.id}
              width={Math.max(16, sidebarWidth - 4)}
              theme="midnight"
              onSelectFile={setSelectedFileId}
            />
          </scrollbox>
        </WindowFrame>

        <box style={{ width: gap }} />

        <box style={{ width: mainWidth, height: contentHeight, flexDirection: "column" }}>
          <WindowFrame title="HunkDiffFileHeader" width={mainWidth} height={headerWindowHeight}>
            {selectedFile ? (
              <HunkDiffFileHeader
                file={selectedFile}
                width={Math.max(20, mainWidth - 4)}
                theme="midnight"
              />
            ) : (
              <text fg="#8da5c7">No file selected.</text>
            )}
          </WindowFrame>

          <box style={{ height: gap }} />

          <WindowFrame
            title={`HunkDiffBody (${layout})`}
            width={mainWidth}
            height={bodyWindowHeight}
          >
            <scrollbox
              width="100%"
              height="100%"
              scrollY={true}
              viewportCulling={true}
              focused={false}
            >
              <HunkDiffBody
                file={selectedFile}
                layout={layout}
                width={Math.max(20, mainWidth - 4)}
                theme="midnight"
              />
            </scrollbox>
          </WindowFrame>

          <box style={{ height: gap }} />

          <WindowFrame title="HunkReviewStream" width={mainWidth} height={streamWindowHeight}>
            <scrollbox
              width="100%"
              height="100%"
              scrollY={true}
              viewportCulling={true}
              focused={false}
            >
              <HunkReviewStream
                files={files}
                layout={layout}
                width={Math.max(20, mainWidth - 4)}
                theme="midnight"
                selection={{ fileId: selectedFile?.id ?? "", hunkIndex: 0 }}
                showFileSeparators={false}
                onSelectionChange={(selection) => setSelectedFileId(selection.fileId)}
              />
            </scrollbox>
          </WindowFrame>
        </box>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  useAlternateScreen: true,
  useMouse: true,
  exitOnCtrlC: true,
  openConsoleOnError: true,
});
const root = createRoot(renderer);

root.render(<PrimitivesDemoApp onQuit={() => renderer.destroy()} />);
