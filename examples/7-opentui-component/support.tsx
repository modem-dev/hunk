import { readFileSync } from "node:fs";
import path from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useTerminalDimensions } from "@opentui/react";
import type { HunkDiffFile, HunkDiffLayout } from "../../src/opentui";
import { HunkDiffView } from "../../src/opentui";

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

function ExampleApp({ title, subtitle, diff, layout = "split" }: ExampleProps) {
  const terminal = useTerminalDimensions();
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
      <text fg="#d8b4fe">{title}</text>
      <text fg="#8f9bb3">{subtitle}</text>
      <box style={{ height: 1 }} />
      <box style={{ flexGrow: 1 }}>
        <HunkDiffView diff={diff} layout={layout} width={diffWidth} theme="midnight" />
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
