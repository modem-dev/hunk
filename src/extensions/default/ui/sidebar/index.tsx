import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionSidebarViewProps } from "../../../../extension-api/types";
import {
  buildSidebarEntries,
  sidebarEntryStatsWidth,
  type SidebarEntry,
} from "../../../../ui/lib/files";
import { fileRowId } from "../../../../ui/lib/ids";
import { buildSidebarRenderWindow } from "../../../../ui/lib/sidebarRenderWindow";
import { FileGroupHeader, FileListItem } from "../../../../ui/components/panes/FileListItem";
import { HUNK_VENDOR_EXTENSION_ID } from "../../../extensionIds";
import { runExtensionFactory } from "../../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionFactory,
  type ExtensionLoadIssue,
  type RegisteredSidebarView,
} from "../../../types";

/**
 * Hunk's file-navigation sidebar, shipped as a bundled extension.
 *
 * Like the Git backend, the built-in sidebar registers through the public API —
 * `registerSidebarView` — and its component consumes exactly the published
 * `ExtensionSidebarViewProps`: the frozen file views for its entries, the theme
 * token slice for its colors, `actions.selectFile` for navigation, and the
 * host-served `@opentui/react` for its hooks. That is what keeps the sidebar
 * contract honest: anything this pane needs that the props cannot express is a
 * real gap in what third-party sidebars can build.
 *
 * Unlike the VCS tier this module is UI code, so it is deliberately *not* part
 * of `loadBundledExtensions` — that list is imported from VCS adapter
 * resolution, which must stay renderer-free. The sidebar instead loads through
 * `getBundledSidebarView` at the one place the app resolves its active sidebar.
 * Rendering helpers (row components, the render window) are imported from Hunk
 * directly: this is host code, and the dogfooding boundary is the data,
 * actions, and theme crossing the props — not utility code.
 */

/**
 * The bundled sidebar registers under Hunk's vendor id, not under `sidebar`.
 *
 * View keys are `<extensionId>:<viewId>`, and extension ids are file stems a
 * user picks, so `sidebar.ts` on disk would otherwise mint `sidebar:files` and
 * collide with this view. `hunk` is reserved at load, so this key cannot be
 * taken. The `sourcePath` below still names the module, since that is what it
 * describes.
 */
export const BUNDLED_SIDEBAR_EXTENSION_ID = HUNK_VENDOR_EXTENSION_ID;
export const BUNDLED_SIDEBAR_VIEW_ID = "files";

/** Render the built-in file navigation sidebar from the public sidebar props. */
export function BuiltInSidebarView({
  files,
  selectedFileId,
  theme,
  width,
  actions,
}: ExtensionSidebarViewProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [scrollViewport, setScrollViewport] = useState({ top: 0, height: 0 });
  const terminal = useTerminalDimensions();
  // Mirrors the host layout: one column of row highlight plus row padding.
  const textWidth = Math.max(8, width - 2);
  const entries = useMemo<SidebarEntry[]>(() => buildSidebarEntries(files), [files]);
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const statsWidth = Math.max(0, ...fileEntries.map((entry) => sidebarEntryStatsWidth(entry)));
  const renderWindow = useMemo(
    () =>
      buildSidebarRenderWindow({
        entries,
        estimatedViewportRows: terminal.height,
        overscanRows: 4,
        scrollTop: scrollViewport.top,
        selectedFileId: selectedFileId ?? undefined,
        viewportHeight: scrollViewport.height,
      }),
    [entries, terminal.height, scrollViewport.height, scrollViewport.top, selectedFileId],
  );

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) {
      return;
    }

    let cancelled = false;
    let scheduled = false;

    const readViewport = () => {
      const nextTop = scrollBox.scrollTop ?? 0;
      const nextHeight = scrollBox.viewport.height ?? 0;
      setScrollViewport((current) =>
        current.top === nextTop && current.height === nextHeight
          ? current
          : { top: nextTop, height: nextHeight },
      );
    };

    const handleViewportChange = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        if (cancelled) {
          scheduled = false;
          return;
        }

        try {
          readViewport();
        } finally {
          scheduled = false;
        }
      });
    };

    readViewport();
    scrollBox.verticalScrollBar.on("change", handleViewportChange);
    scrollBox.viewport.on("layout-changed", handleViewportChange);
    scrollBox.viewport.on("resized", handleViewportChange);

    return () => {
      cancelled = true;
      scrollBox.verticalScrollBar.off("change", handleViewportChange);
      scrollBox.viewport.off("layout-changed", handleViewportChange);
      scrollBox.viewport.off("resized", handleViewportChange);
    };
  }, [entries.length]);

  // Keep the selected file's row visible as navigation moves the selection —
  // behavior the sidebar owns, so every sidebar (custom ones included) decides
  // its own follow policy instead of the host scrolling a pane it cannot see.
  useEffect(() => {
    if (!selectedFileId) {
      return;
    }

    scrollRef.current?.scrollChildIntoView(fileRowId(selectedFileId));
  }, [selectedFileId]);

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      viewportCulling={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column" }}>
        {renderWindow.items.map((item) => {
          if (item.kind === "spacer") {
            return (
              <box
                key={item.key}
                style={{ width: "100%", height: item.height, backgroundColor: theme.panel }}
              />
            );
          }

          const { entry } = item;
          return entry.kind === "group" ? (
            <FileGroupHeader key={entry.id} entry={entry} textWidth={textWidth} theme={theme} />
          ) : (
            <FileListItem
              key={entry.id}
              entry={entry}
              selected={entry.id === selectedFileId}
              statsWidth={statsWidth}
              textWidth={textWidth}
              theme={theme}
              onSelectFile={actions.selectFile}
            />
          );
        })}
      </box>
    </scrollbox>
  );
}

/** The factory the bundled sidebar registers through, same as any extension. */
const registerBundledSidebar: ExtensionFactory = (hunk) => {
  hunk.registerSidebarView({ id: BUNDLED_SIDEBAR_VIEW_ID, component: BuiltInSidebarView });
};

export default registerBundledSidebar;

let cachedView: RegisteredSidebarView | undefined;

/**
 * Load the bundled sidebar registration, once per process.
 *
 * Runs the factory through `runExtensionFactory` — the same seal, validation,
 * and registry path user extensions take — and hands back the one registration
 * it produced. The app uses it as the default a user-registered sidebar view
 * overrides. A failure here is a Hunk bug, not an extension author's, so it
 * throws instead of degrading.
 */
export function getBundledSidebarView(): RegisteredSidebarView {
  if (cachedView) {
    return cachedView;
  }

  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  runExtensionFactory({
    metadata: {
      id: BUNDLED_SIDEBAR_EXTENSION_ID,
      sourcePath: "hunk:bundled/sidebar",
      origin: "bundled",
    },
    registry,
    issues,
    factory: registerBundledSidebar,
  });

  const view = registry.sidebarViews[0];
  if (issues.length > 0 || !view) {
    throw new Error(
      `Bundled sidebar failed to register: ${issues[0]?.message ?? "no view registered"}`,
    );
  }

  cachedView = view;
  return cachedView;
}
