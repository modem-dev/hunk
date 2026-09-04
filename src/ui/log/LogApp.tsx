import type { KeyEvent, MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { basename } from "node:path";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import { fitText } from "../lib/text";
import { formatHistoryDecorations, renderHistoryGraph } from "../history/staticProjection";
import type { HistoryRuntime } from "../history/types";
import type { LogController } from "./controller";
import { LOG_HELP_SECTIONS } from "./logHelp";
import {
  isLogCommandEnabled,
  logCommand,
  logCommandHint,
  matchLogCommand,
  type LogCommandId,
} from "./commands";
import { ParentSelectorDialog } from "./ParentSelectorDialog";
import { monochromeLogTheme } from "./colorPolicy";

export type LogAppOutcome =
  | { kind: "quit"; exitCode?: number }
  | { kind: "open-review"; action: ExtensionVcsHistoryReviewAction; themeId: string };

/** Render the bounded history list inside Hunk's shared desktop chrome. */
export function LogApp({
  controller,
  runtime,
  onOutcome,
  useColor,
}: {
  controller: LogController;
  runtime: HistoryRuntime;
  onOutcome: (outcome: LogAppOutcome) => void;
  useColor: boolean;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const [showHelp, setShowHelp] = useState(false);
  const [parentSelectorIndex, setParentSelectorIndex] = useState<number | null>(null);
  const [transientNotice, setTransientNotice] = useState("");
  const lastClick = useRef({ index: -1, at: 0 });
  // Lock synchronously before awaiting provider planning so coalesced Enter+q input cannot
  // quit the log or leak the trailing command into the child review.
  const reviewPending = useRef(false);
  const themeController = useThemeSelectorController({
    customThemes: runtime.customThemes,
    initialTheme: snapshot.themeId,
    initialThemeMode: renderer.themeMode,
    onTransientNotice: setTransientNotice,
    onThemeCommitted: (id) => controller.setTheme(id),
    transparentBackground: false,
  });
  const terminalThemeMode = renderer.themeMode ?? "dark";
  const theme = useColor
    ? themeController.activeTheme
    : monochromeLogTheme(themeController.activeTheme, terminalThemeMode);
  const chromeTheme = useColor
    ? themeController.baseTheme
    : monochromeLogTheme(themeController.baseTheme, terminalThemeMode);
  const selectedRow = snapshot.rows[snapshot.selected];
  const detailHeight =
    snapshot.presentation.format === "medium" && selectedRow && terminal.height >= 9 ? 5 : 0;
  const viewportHeight = Math.max(1, terminal.height - 2 - detailHeight);

  const copySelected = () => {
    const currentRow = controller.getSelectedRow();
    if (!currentRow) return;
    if (renderer.isOsc52Supported?.() && typeof renderer.copyToClipboardOSC52 === "function") {
      renderer.copyToClipboardOSC52(currentRow.commit.revisionId);
      setTransientNotice(`Copied ${currentRow.commit.displayId}`);
    } else {
      setTransientNotice("Clipboard is unavailable in this terminal.");
    }
  };
  const openSelected = async (parentRevisionId?: string) => {
    if (reviewPending.current) return;
    const planned = controller.planSelectedReview(parentRevisionId);
    if (!planned) return;
    reviewPending.current = true;
    try {
      onOutcome({
        kind: "open-review",
        action: await planned,
        themeId: themeController.themeId,
      });
    } catch (error) {
      reviewPending.current = false;
      controller.setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!transientNotice) return;
    const timeout = setTimeout(() => setTransientNotice(""), 2500);
    return () => clearTimeout(timeout);
  }, [transientNotice]);

  const clearTransientNotice = () => setTransientNotice("");
  const executeCommand = (id: LogCommandId, exitCode?: number) => {
    clearTransientNotice();
    if (!isLogCommandEnabled(id, controller.getSnapshot())) return;
    switch (id) {
      case "open":
        void openSelected();
        break;
      case "copy":
        copySelected();
        break;
      case "refresh":
        void controller.refresh();
        break;
      case "quit":
        onOutcome({ kind: "quit", ...(exitCode === undefined ? {} : { exitCode }) });
        break;
      case "theme":
        themeController.openThemeSelector();
        break;
      case "format-medium":
        controller.setFormat("medium");
        break;
      case "format-compact":
        controller.setFormat("compact");
        break;
      case "toggle-graph":
        controller.togglePresentation("graph");
        break;
      case "toggle-unicode":
        controller.togglePresentation("unicode");
        break;
      case "toggle-author":
        controller.togglePresentation("author");
        break;
      case "toggle-date":
        controller.togglePresentation("date");
        break;
      case "toggle-decorations":
        controller.togglePresentation("decorations");
        break;
      case "previous":
        void controller.move(-1, viewportHeight);
        break;
      case "next":
        void controller.move(1, viewportHeight);
        break;
      case "page-up":
        void controller.page(-1, viewportHeight);
        break;
      case "page-down":
        void controller.page(1, viewportHeight);
        break;
      case "first":
        void controller.first(viewportHeight);
        break;
      case "last":
        void controller.last(viewportHeight);
        break;
      case "search":
        controller.beginSearch();
        break;
      case "next-match":
        void controller.findMatch(1, viewportHeight);
        break;
      case "previous-match":
        void controller.findMatch(-1, viewportHeight);
        break;
      case "open-first-parent": {
        const parent = controller.getSelectedRow()?.commit.parentRevisionIds[0];
        if (parent) void openSelected(parent);
        break;
      }
      case "open-parent":
        setParentSelectorIndex(0);
        break;
      case "help":
        setShowHelp(true);
        break;
      case "about":
        setTransientNotice("Hunk · terminal-native code review");
        break;
    }
  };
  const commandItem = (
    id: LogCommandId,
    options: Pick<Extract<MenuEntry, { kind: "item" }>, "checked"> = {},
  ): Extract<MenuEntry, { kind: "item" }> => {
    const definition = logCommand(id);
    return {
      kind: "item",
      commandId: `hunk.log.${id}`,
      label: definition.label,
      ...(logCommandHint(id) ? { hint: logCommandHint(id) } : {}),
      disabled: !isLogCommandEnabled(id, snapshot),
      action: () => executeCommand(id),
      ...options,
    };
  };
  const menus: AppMenus = {
    file: [
      commandItem("open"),
      commandItem("copy"),
      commandItem("refresh"),
      { kind: "separator" },
      commandItem("quit"),
    ],
    view: [
      commandItem("theme"),
      { kind: "separator" },
      commandItem("format-medium", { checked: snapshot.presentation.format === "medium" }),
      commandItem("format-compact", { checked: snapshot.presentation.format === "compact" }),
      { kind: "separator" },
      commandItem("toggle-graph", { checked: snapshot.presentation.graph }),
      commandItem("toggle-unicode", { checked: snapshot.presentation.unicode }),
      commandItem("toggle-author", { checked: snapshot.presentation.author }),
      commandItem("toggle-date", { checked: snapshot.presentation.date }),
      commandItem("toggle-decorations", { checked: snapshot.presentation.decorations }),
    ],
    navigate: [
      commandItem("previous"),
      commandItem("next"),
      commandItem("page-up"),
      commandItem("page-down"),
      commandItem("first"),
      commandItem("last"),
      { kind: "separator" },
      commandItem("search"),
      commandItem("next-match"),
      commandItem("previous-match"),
    ],
    commit: [
      commandItem("open"),
      commandItem("copy"),
      { kind: "separator" },
      commandItem("open-first-parent"),
      commandItem("open-parent"),
    ],
    help: [commandItem("help"), commandItem("about")],
  };
  const menu = useMenuController(menus);

  useEffect(() => {
    void controller.loadMore();
  }, [controller]);
  useEffect(() => {
    controller.clampViewport(viewportHeight);
    if (snapshot.top + viewportHeight + 8 >= snapshot.rows.length && !snapshot.historyDone) {
      void controller.loadMore();
    }
  }, [controller, snapshot.historyDone, snapshot.rows.length, snapshot.top, viewportHeight]);

  useKeyboard((key: KeyEvent) => {
    clearTransientNotice();
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (reviewPending.current) {
      consume();
      return;
    }
    const name = key.name;
    const sequence = key.sequence ?? "";
    if (parentSelectorIndex !== null) {
      const parents = controller.getSelectedRow()?.commit.parentRevisionIds ?? [];
      if (name === "escape") setParentSelectorIndex(null);
      else if (name === "up")
        setParentSelectorIndex((parentSelectorIndex - 1 + parents.length) % parents.length);
      else if (name === "down" || name === "tab")
        setParentSelectorIndex(
          (parentSelectorIndex + (key.shift ? -1 : 1) + parents.length) % parents.length,
        );
      else if (name === "return" || name === "enter") {
        const parent = parents[parentSelectorIndex];
        setParentSelectorIndex(null);
        if (parent) void openSelected(parent);
      } else return;
      consume();
      return;
    }
    if (themeController.themeSelectorOpen) {
      if (name === "escape") themeController.closeThemeSelector();
      else if (name === "up") themeController.moveThemeSelector(-1);
      else if (name === "down" || name === "tab")
        themeController.moveThemeSelector(key.shift ? -1 : 1);
      else if (name === "return" || name === "enter") themeController.acceptThemeSelector();
      else return;
      consume();
      return;
    }
    if (showHelp) {
      if (name === "escape" || name === "q" || sequence === "q") setShowHelp(false);
      else return;
      consume();
      return;
    }
    if (menu.getActiveMenuId()) {
      if (name === "escape") menu.closeMenu();
      else if (name === "left") menu.switchMenu(-1);
      else if (name === "right" || name === "tab") menu.switchMenu(1);
      else if (name === "up") menu.moveMenuItem(-1);
      else if (name === "down") menu.moveMenuItem(1);
      else if (name === "return" || name === "enter") menu.activateCurrentMenuItem();
      else {
        const command = matchLogCommand(key);
        if (!command) return;
        menu.closeMenu();
        executeCommand(command, key.ctrl && key.name === "c" ? 130 : undefined);
      }
      consume();
      return;
    }
    if (snapshot.searchEditing) {
      if ((key.ctrl && name === "c") || name === "escape") controller.cancelSearch();
      else if (name === "return" || name === "enter")
        void controller.finishSearch(1, viewportHeight);
      else if (name === "backspace") controller.backspaceSearch();
      else if (/^[^\x00-\x1f\x7f]+$/u.test(sequence)) controller.appendSearch(sequence);
      else return;
      consume();
      return;
    }
    if (name === "f10") {
      menu.openMenu("file");
      consume();
      return;
    }
    const command = matchLogCommand(key);
    if (!command) return;
    executeCommand(command, key.ctrl && key.name === "c" ? 130 : undefined);
    consume();
  });

  const visible = snapshot.rows.slice(snapshot.top, snapshot.top + viewportHeight);
  const rowWidth = Math.max(1, terminal.width - 2);
  const statusHint = terminal.width >= 48 ? "↑↓ move · Enter open · / search · F10 menu" : "";
  const statusTextWidth = Math.max(1, terminal.width - (statusHint ? 42 : 2));
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.background,
      }}
    >
      <MenuBar
        activeMenuId={menu.activeMenuId}
        menuSpecs={menu.menuSpecs}
        terminalWidth={terminal.width}
        theme={theme}
        topTitle={`${sanitizeTerminalLine(basename(runtime.repoRoot))} · ${sanitizeTerminalLine(runtime.providerName)} history`}
        onHoverMenu={(id) => {
          if (menu.activeMenuId) menu.openMenu(id);
        }}
        onToggleMenu={menu.toggleMenu}
      />
      <box
        style={{
          width: "100%",
          height: viewportHeight,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
        }}
        onMouseUp={() => menu.closeMenu()}
        onMouseScroll={(event: TuiMouseEvent) => {
          menu.closeMenu();
          const direction = event.scroll?.direction;
          if (direction === "up") controller.move(-3, viewportHeight);
          else if (direction === "down") controller.move(3, viewportHeight);
        }}
      >
        {visible.map((row, offset) => {
          const index = snapshot.top + offset;
          const selected = index === snapshot.selected;
          const graph = snapshot.presentation.graph
            ? `${renderHistoryGraph(row, !snapshot.presentation.unicode)}  `
            : "";
          const decorations = snapshot.presentation.decorations
            ? formatHistoryDecorations(row)
            : "";
          const author = snapshot.presentation.author
            ? `  ${sanitizeTerminalLine(row.commit.authorName)}`
            : "";
          const date = snapshot.presentation.date
            ? `  ${sanitizeTerminalLine(row.commit.authoredAt).slice(0, 10)}`
            : "";
          const subject = fitText(
            `${sanitizeTerminalLine(row.commit.subject)}${decorations}${author}${date}`,
            Math.max(1, rowWidth - graph.length - row.commit.displayId.length - 2),
          );
          return (
            <box
              key={row.commit.revisionId}
              style={{
                height: 1,
                width: "100%",
                flexDirection: "row",
                backgroundColor: selected ? theme.selectedHunk : theme.background,
              }}
              onMouseUp={() => {
                clearTransientNotice();
                const now = Date.now();
                const shouldOpen =
                  lastClick.current.index === index && now - lastClick.current.at < 400;
                void controller.select(index, viewportHeight).then(() => {
                  if (shouldOpen) void openSelected();
                });
                lastClick.current = { index, at: now };
              }}
            >
              {graph ? <text fg={theme.muted}>{graph}</text> : null}
              <box
                onMouseUp={(event: TuiMouseEvent) => {
                  event.stopPropagation();
                  clearTransientNotice();
                  void controller.select(index, viewportHeight).then(() => openSelected());
                }}
              >
                <text fg={theme.accent}>{row.commit.displayId}</text>
              </box>
              <text fg={theme.text}>{`  ${subject}`}</text>
            </box>
          );
        })}
      </box>
      {detailHeight && selectedRow ? (
        <box
          style={{
            height: detailHeight,
            width: "100%",
            paddingLeft: 2,
            flexDirection: "column",
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.text}>{fitText(selectedRow.commit.subject, rowWidth)}</text>
          <text fg={theme.muted}>
            {fitText(
              sanitizeTerminalLine(
                `${selectedRow.commit.authorName}${selectedRow.commit.authorEmail ? ` <${selectedRow.commit.authorEmail}>` : ""}`,
              ),
              rowWidth,
            )}
          </text>
          <text fg={theme.muted}>
            {fitText(sanitizeTerminalLine(selectedRow.commit.authoredAt), rowWidth)}
          </text>
          <text fg={theme.text}>
            {fitText(
              sanitizeTerminalLine((selectedRow.commit.body ?? "").replaceAll("\n", " ")),
              rowWidth,
            )}
          </text>
          <text fg={theme.muted}>
            {fitText(sanitizeTerminalLine(selectedRow.commit.revisionId), rowWidth)}
          </text>
        </box>
      ) : null}
      <box
        style={{
          height: 1,
          width: "100%",
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.panelAlt,
        }}
        onMouseUp={menu.closeMenu}
      >
        <text fg={theme.muted}>
          {fitText(
            snapshot.searchEditing
              ? `/${snapshot.search}`
              : transientNotice ||
                  snapshot.notice ||
                  `${runtime.providerName} · ${snapshot.rows.length}${snapshot.historyDone ? " commits" : "+ commits"}`,
            statusTextWidth,
          )}
        </text>
        {statusHint ? <text fg={theme.muted}>{statusHint}</text> : null}
      </box>
      {menu.activeMenuId && menu.activeMenuSpec ? (
        <MenuDropdown
          activeMenuId={menu.activeMenuId}
          activeMenuEntries={menu.activeMenuEntries}
          activeMenuItemIndex={menu.activeMenuItemIndex}
          activeMenuSpec={menu.activeMenuSpec}
          activeMenuWidth={menu.activeMenuWidth}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onHoverItem={menu.setActiveMenuItemIndex}
          onSelectItem={(entry: Extract<MenuEntry, { kind: "item" }>) => {
            if (!entry.disabled) entry.action();
            menu.closeMenu();
          }}
        />
      ) : null}
      {parentSelectorIndex !== null && selectedRow ? (
        <ParentSelectorDialog
          parentRevisionIds={selectedRow.commit.parentRevisionIds}
          selectedIndex={parentSelectorIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onAccept={(index) => {
            const parent = selectedRow.commit.parentRevisionIds[index];
            setParentSelectorIndex(null);
            if (parent) void openSelected(parent);
          }}
          onClose={() => setParentSelectorIndex(null)}
          onSelect={setParentSelectorIndex}
        />
      ) : null}
      {themeController.themeSelectorOpen ? (
        <ThemeSelectorDialog
          items={themeController.themeSelectorItems}
          selectedIndex={themeController.themeSelectorSelectedIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onAcceptItem={themeController.acceptThemeSelectorItem}
          onClose={themeController.closeThemeSelector}
          onPreviewItem={themeController.previewThemeSelectorItem}
        />
      ) : null}
      {showHelp ? (
        <HelpDialog
          sections={LOG_HELP_SECTIONS}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onClose={() => setShowHelp(false)}
        />
      ) : null}
    </box>
  );
}
