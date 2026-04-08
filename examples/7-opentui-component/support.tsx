import { readFileSync } from "node:fs";
import path from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";
import type { HunkDiffFile, HunkDiffLayout } from "../../src/opentui";
import { HunkDiffView } from "../../src/opentui";
import { fitText } from "../../src/ui/lib/text";

interface ExampleProps {
  title: string;
  subtitle: string;
  diff: HunkDiffFile;
  layout?: HunkDiffLayout;
}

/** Read one checked-in example file relative to this folder. */
export function readExampleFile(name: string) {
  return readFileSync(path.join(import.meta.dir, name), "utf8");
}

function LayoutButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <box
      style={{
        width: label.length + 2,
        height: 1,
        backgroundColor: active ? "#452650" : "#1f2430",
      }}
      onMouseUp={onPress}
    >
      <text fg={active ? "#fff0ff" : "#8f9bb3"}>{` ${label} `}</text>
    </box>
  );
}

function ExampleApp({ title, subtitle, diff, layout = "split" }: ExampleProps) {
  const [activeLayout, setActiveLayout] = useState(layout);
  const terminal = useTerminalDimensions();
  const headerWidth = Math.max(1, terminal.width - 2);
  const diffWidth = Math.max(24, terminal.width - 2);

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg="#d8b4fe">{fitText(title, headerWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }}>
        <text fg="#8f9bb3">{fitText(subtitle, headerWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <text fg="#6b7280">layout</text>
        <box style={{ width: 1, height: 1 }} />
        <LayoutButton
          active={activeLayout === "split"}
          label="Split"
          onPress={() => setActiveLayout("split")}
        />
        <box style={{ width: 1, height: 1 }} />
        <LayoutButton
          active={activeLayout === "stack"}
          label="Stack"
          onPress={() => setActiveLayout("stack")}
        />
      </box>
      <box style={{ height: 1 }} />
      <box style={{ flexGrow: 1 }}>
        <HunkDiffView diff={diff} layout={activeLayout} width={diffWidth} theme="midnight" />
      </box>
    </box>
  );
}

/** Launch a tiny OpenTUI app that embeds the exported Hunk diff component. */
export async function runExample(props: ExampleProps) {
  const renderer = await createCliRenderer({
    useAlternateScreen: true,
    useMouse: true,
    exitOnCtrlC: true,
    openConsoleOnError: true,
  });
  const root = createRoot(renderer);

  root.render(<ExampleApp {...props} />);
}
