import { createMemo, For, Match, mergeProps, Switch } from "solid-js";
import { FileGroupHeader, FileListItem } from "../ui/components/panes/FileListItem";
import { buildSidebarEntries, sidebarEntryStatsWidth } from "../ui/lib/files";
import { resolveTheme } from "../ui/themes";
import { toInternalDiffFiles } from "./model";
import type { HunkFileNavProps } from "./types";

/** Render Hunk's file navigation list without global shortcuts, scrolling, borders, or surrounding chrome. */
export function HunkFileNav(props: HunkFileNavProps) {
  const merged = mergeProps({ theme: "graphite" as const, onSelectFile: () => {} }, props);
  const resolvedTheme = createMemo(() => resolveTheme(merged.theme, null));
  const internalFiles = createMemo(() => toInternalDiffFiles(merged.files));
  const entries = createMemo(() => buildSidebarEntries(internalFiles()));
  const statsWidth = createMemo(() => {
    const fileEntries = entries().filter((entry) => entry.kind === "file");
    return Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  });
  const textWidth = createMemo(() => Math.max(1, merged.width - 1));

  return (
    <box style={{ width: "100%", flexDirection: "column", backgroundColor: resolvedTheme().panel }}>
      <For each={entries()}>
        {(entry) => (
          <Switch>
            <Match when={entry.kind === "group" ? entry : null}>
              {(groupEntry) => (
                <FileGroupHeader
                  entry={groupEntry()}
                  paddingLeft={0}
                  textWidth={Math.max(1, merged.width)}
                  theme={resolvedTheme()}
                />
              )}
            </Match>
            <Match when={entry.kind === "file" ? entry : null}>
              {(fileEntry) => (
                <FileListItem
                  entry={fileEntry()}
                  paddingLeft={0}
                  selected={fileEntry().id === merged.selectedFileId}
                  statsWidth={statsWidth()}
                  textWidth={textWidth()}
                  theme={resolvedTheme()}
                  onSelectFile={merged.onSelectFile}
                />
              )}
            </Match>
          </Switch>
        )}
      </For>
    </box>
  );
}
