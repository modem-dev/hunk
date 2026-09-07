import type { KeyEvent, MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { basename } from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionVcsHistoryRangeSelection } from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { resolveExtensionSessionOptions } from "../../extensions/apply";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import { ViewPreferenceQuitDialog } from "../components/chrome/ViewPreferenceQuitDialog";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import {
  useViewPreferenceQuitController,
  type ViewPreferenceQuitScheduler,
} from "../hooks/useViewPreferenceQuitController";
import { fitText, measureTextWidth } from "../lib/text";
import { handleViewPreferenceQuitPromptKey } from "../lib/viewPreferenceQuitKeys";
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
import { monochromeLogTheme, resolveInteractiveLogPalette } from "./colorPolicy";
import { formatHistoryDay } from "./formatting";
import { LOG_DAY_HEADER_HEIGHT, planLogViewportGeometry } from "./geometry";
import { projectResponsiveLogRow, resolveLogResponsiveLayout } from "./responsiveLayout";

/** Render graph cells with stable semantic colors from the active Hunk theme. */
function HistoryGraphLine({ text, colors }: { text: string; colors: readonly string[] }) {
  return (
    <text>
      {Array.from({ length: Math.ceil(text.length / 2) }, (_, lane) => (
        <span key={lane} fg={colors[lane % colors.length]!}>
          {text.slice(lane * 2, lane * 2 + 2)}
        </span>
      ))}
    </text>
  );
}

export type LogAppOutcome =
  | { kind: "quit"; exitCode?: number }
  | { kind: "cancel-open-review" }
  | {
      kind: "open-review";
      selection: ExtensionVcsHistoryRangeSelection;
      count: number;
      parentRevisionId?: string;
      themeId: string;
      themeMode: "dark" | "light";
    };

/** Render the bounded history list inside Hunk's shared desktop chrome. */
export function LogApp({
  controller,
  runtime,
  onOutcome,
  useColor,
  quitScheduler,
}: {
  controller: LogController;
  runtime: HistoryRuntime;
  onOutcome: (outcome: LogAppOutcome) => void | Promise<void>;
  useColor: boolean;
  quitScheduler?: ViewPreferenceQuitScheduler;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const [showHelp, setShowHelp] = useState(false);
  const [parentSelectorIndex, setParentSelectorIndex] = useState<number | null>(null);
  const [transientNotice, setTransientNotice] = useState("");
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const [openingCommit, setOpeningCommit] = useState<{
    id: string;
    subject: string;
    count: number;
  } | null>(null);
  const lastClick = useRef({ index: -1, at: 0 });
  // Lock synchronously before requesting review preparation so coalesced input cannot
  // open two child reviews. Quit remains available while the host settles pending work.
  const reviewPending = useRef(false);
  const reviewQuitEnabled = useRef(false);
  const quitRequestCaptured = useRef(false);
  const pendingExitCode = useRef<number | undefined>(undefined);
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
  const logPalette = resolveInteractiveLogPalette(theme);
  const graphColors = snapshot.presentation.graph ? logPalette.graphLanes : [logPalette.timeline];
  const selection = controller.getSelection();
  const parentRow = selection?.oldest;
  const responsiveLayout = resolveLogResponsiveLayout(terminal.width, terminal.height);
  const viewportBodyHeight = responsiveLayout.bodyHeight;
  const currentViewPreferences = useMemo(
    () => ({ ...runtime.initialViewPreferences, theme: themeController.themeId }),
    [runtime.initialViewPreferences, themeController.themeId],
  );
  const viewPreferenceQuit = useViewPreferenceQuitController({
    currentPreferences: currentViewPreferences,
    configPath: runtime.viewPreferencesConfigPath,
    pagerMode: false,
    promptSaveViewPreferences: runtime.promptSaveViewPreferences,
    transientViewPreferences: resolveExtensionSessionOptions(
      runtime.extensionSession.current.registry,
    ).transientViewPreferences,
    onQuit: () => {
      const exitCode = pendingExitCode.current;
      pendingExitCode.current = undefined;
      quitRequestCaptured.current = false;
      void onOutcome({ kind: "quit", ...(exitCode === undefined ? {} : { exitCode }) });
    },
    showNotice: setTransientNotice,
    showError: setTransientNotice,
    closeHelp: () => setShowHelp(false),
    homeDirectory: process.env.HOME,
    quitScheduler,
  });

  const copySelected = (row = controller.getSelectedRow()) => {
    const currentRow = row;
    if (!currentRow) return;
    if (renderer.isOsc52Supported?.() && typeof renderer.copyToClipboardOSC52 === "function") {
      renderer.copyToClipboardOSC52(currentRow.commit.revisionId);
      setTransientNotice(`Copied ${currentRow.commit.displayId}`);
    } else {
      setTransientNotice("Clipboard is unavailable in this terminal.");
    }
  };
  const openSelected = async (parentRevisionId?: string, pending = false) => {
    if (reviewPending.current && !pending) return;
    reviewPending.current = true;
    reviewQuitEnabled.current = false;
    await controller.settleNavigation();
    const currentSelection = controller.getSelection();
    if (!currentSelection) {
      reviewPending.current = false;
      return;
    }
    setOpeningCommit({
      id: sanitizeTerminalLine(currentSelection.focus.commit.displayId),
      subject: sanitizeTerminalLine(currentSelection.focus.commit.subject),
      count: currentSelection.count,
    });
    try {
      // Commit the loading surface and consume input coalesced with the opening key/click before
      // provider planning starts. Deliberate quit input remains available after this boundary.
      await new Promise<void>((resolve) => setImmediate(resolve));
      reviewQuitEnabled.current = true;
      await onOutcome({
        kind: "open-review",
        selection: {
          newestCommit: currentSelection.newest.commit,
          oldestCommit: currentSelection.oldest.commit,
        },
        count: currentSelection.count,
        ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
        themeId: themeController.themeId,
        themeMode: terminalThemeMode,
      });
    } catch (error) {
      reviewPending.current = false;
      reviewQuitEnabled.current = false;
      setOpeningCommit(null);
      controller.setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!transientNotice) return;
    const timeout = setTimeout(() => setTransientNotice(""), 2500);
    return () => clearTimeout(timeout);
  }, [transientNotice]);

  const clearTransientNotice = () => setTransientNotice("");
  /** Stop pending review preparation before beginning the history-owned quit decision. */
  const requestLogQuit = (exitCode?: number) => {
    if (!quitRequestCaptured.current) {
      quitRequestCaptured.current = true;
      pendingExitCode.current = exitCode;
    }
    if (reviewPending.current && reviewQuitEnabled.current) {
      reviewQuitEnabled.current = false;
      void Promise.resolve(onOutcome({ kind: "cancel-open-review" })).then(
        () => {
          reviewPending.current = false;
          setOpeningCommit(null);
        },
        (error) => {
          reviewPending.current = false;
          setOpeningCommit(null);
          controller.setNotice(error instanceof Error ? error.message : String(error));
        },
      );
    }
    viewPreferenceQuit.requestQuit();
  };
  const closeLogSaveConfigPrompt = () => {
    quitRequestCaptured.current = false;
    pendingExitCode.current = undefined;
    viewPreferenceQuit.closeSaveConfigPrompt();
  };
  const logViewPreferenceQuit = {
    ...viewPreferenceQuit,
    closeSaveConfigPrompt: closeLogSaveConfigPrompt,
  };
  const requestOpenSelected = async () => {
    if (reviewPending.current) return;
    reviewPending.current = true;
    reviewQuitEnabled.current = false;
    await controller.settleNavigation();
    const currentSelection = controller.getSelection();
    if (
      currentSelection &&
      currentSelection.count > 1 &&
      currentSelection.oldest.commit.parentRevisionIds.length > 1
    ) {
      reviewPending.current = false;
      setParentSelectorIndex(0);
      return;
    }
    await openSelected(undefined, true);
  };
  const executeCommand = (id: LogCommandId, exitCode?: number) => {
    clearTransientNotice();
    if (!isLogCommandEnabled(id, controller.getSnapshot())) return;
    switch (id) {
      case "open":
        void requestOpenSelected();
        break;
      case "copy":
        copySelected();
        break;
      case "refresh":
        void controller.refresh();
        break;
      case "quit":
        requestLogQuit(exitCode);
        break;
      case "theme":
        themeController.openThemeSelector();
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
        void controller.move(-1, viewportBodyHeight);
        break;
      case "next":
        void controller.move(1, viewportBodyHeight);
        break;
      case "extend-previous":
        void controller.move(-1, viewportBodyHeight, { extend: true });
        break;
      case "extend-next":
        void controller.move(1, viewportBodyHeight, { extend: true });
        break;
      case "page-up":
        void controller.page(-1, viewportBodyHeight);
        break;
      case "page-down":
        void controller.page(1, viewportBodyHeight);
        break;
      case "first":
        void controller.first(viewportBodyHeight);
        break;
      case "last":
        void controller.last(viewportBodyHeight);
        break;
      case "search":
        controller.beginSearch();
        break;
      case "next-match":
        void controller.findMatch(1, viewportBodyHeight);
        break;
      case "previous-match":
        void controller.findMatch(-1, viewportBodyHeight);
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
      commandItem("toggle-graph", { checked: snapshot.presentation.graph }),
      commandItem("toggle-unicode", { checked: snapshot.presentation.unicode }),
      commandItem("toggle-author", { checked: snapshot.presentation.author }),
      commandItem("toggle-date", { checked: snapshot.presentation.date }),
      commandItem("toggle-decorations", { checked: snapshot.presentation.decorations }),
    ],
    navigate: [
      commandItem("previous"),
      commandItem("next"),
      commandItem("extend-previous"),
      commandItem("extend-next"),
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
    const timer = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    controller.clampViewport(viewportBodyHeight);
    const geometry = planLogViewportGeometry({
      rows: snapshot.rows,
      selected: snapshot.selected,
      requestedTop: snapshot.top,
      bodyHeight: viewportBodyHeight,
      groupByDay: !snapshot.presentation.graph,
    });
    if (
      geometry.entries.at(-1)?.index !== undefined &&
      geometry.entries.at(-1)!.index + 8 >= snapshot.rows.length &&
      !snapshot.historyDone
    ) {
      void controller.loadMore();
    }
  }, [
    controller,
    snapshot.historyDone,
    snapshot.presentation.graph,
    snapshot.rows,
    snapshot.selected,
    snapshot.top,
    viewportBodyHeight,
  ]);

  useKeyboard((key: KeyEvent) => {
    clearTransientNotice();
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    const name = key.name;
    const sequence = key.sequence ?? "";
    if (viewPreferenceQuit.saveConfigPromptOpen) {
      handleViewPreferenceQuitPromptKey(key, logViewPreferenceQuit);
      consume();
      return;
    }
    if (reviewPending.current) {
      if (!reviewQuitEnabled.current) {
        const command = matchLogCommand(key);
        if (command === "quit" && key.ctrl && key.name === "c") {
          executeCommand(command, 130);
        }
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
          if (command === "quit") {
            menu.closeMenu();
            executeCommand(command, key.ctrl && key.name === "c" ? 130 : undefined);
          }
        }
        consume();
        return;
      }
      if (name === "f10") menu.openMenu("file");
      else {
        const command = matchLogCommand(key);
        if (command === "quit") {
          executeCommand(command, key.ctrl && key.name === "c" ? 130 : undefined);
        }
      }
      consume();
      return;
    }
    if (parentSelectorIndex !== null) {
      const parents = controller.getSelection()?.oldest.commit.parentRevisionIds ?? [];
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
        void controller.finishSearch(1, viewportBodyHeight);
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

  const viewportGeometry = planLogViewportGeometry({
    rows: snapshot.rows,
    selected: snapshot.selected,
    requestedTop: snapshot.top,
    bodyHeight: viewportBodyHeight,
    groupByDay: !snapshot.presentation.graph,
  });
  const visible = viewportGeometry.entries;
  const statusHint =
    terminal.width >= 120
      ? "↑↓ move · Shift-↑↓ / J/K select · Enter open · / search · F10 menu"
      : terminal.width >= 60
        ? "J/K select · Enter open · F10 menu"
        : "";
  const statusTextWidth = Math.max(
    1,
    terminal.width - measureTextWidth(statusHint) - (statusHint ? 3 : 2),
  );
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
      <box style={{ width: "100%", height: 1 }} />
      <box
        style={{
          width: "100%",
          height: responsiveLayout.bodyHeight,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
        }}
        onMouseUp={() => menu.closeMenu()}
        onMouseScroll={(event: TuiMouseEvent) => {
          menu.closeMenu();
          const direction = event.scroll?.direction;
          if (direction === "up") controller.move(-3, viewportBodyHeight);
          else if (direction === "down") controller.move(3, viewportBodyHeight);
        }}
      >
        {openingCommit ? (
          <box
            style={{
              width: "100%",
              height: responsiveLayout.bodyHeight,
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <text fg={theme.text}>
              {openingCommit.count > 1
                ? `Opening ${openingCommit.count} commits`
                : "Opening commit"}
            </text>
            <text fg={theme.accent}>
              {fitText(
                `${openingCommit.id} · ${openingCommit.subject}`,
                Math.max(1, terminal.width - 4),
              )}
            </text>
            <text fg={theme.muted}>Preparing review…</text>
          </box>
        ) : (
          visible.map(({ index, row, showDayHeader }) => {
            const selected =
              selection !== undefined &&
              index >= selection.newestIndex &&
              index <= selection.oldestIndex;
            const projected = projectResponsiveLogRow({
              row,
              presentation: snapshot.presentation,
              layout: responsiveLayout,
              width: terminal.width,
              now: relativeTimeNow,
            });
            return (
              <box
                key={row.commit.revisionId}
                style={{
                  width: "100%",
                  height: responsiveLayout.rowHeight + (showDayHeader ? LOG_DAY_HEADER_HEIGHT : 0),
                  flexDirection: "column",
                }}
              >
                {showDayHeader ? (
                  <text>
                    <span fg={logPalette.timeline}>
                      {snapshot.presentation.unicode ? "○─" : "o-"}
                    </span>
                    <span fg={logPalette.separator}> </span>
                    <span fg={logPalette.dayHeading}>
                      {fitText(
                        formatHistoryDay(row.commit.authoredAt),
                        Math.max(1, terminal.width - 5),
                      )}
                    </span>
                  </text>
                ) : null}
                {showDayHeader ? (
                  <text fg={logPalette.timeline}>{snapshot.presentation.unicode ? "│" : "|"}</text>
                ) : null}
                <box
                  style={{
                    height: responsiveLayout.rowHeight,
                    width: "100%",
                    flexDirection: "row",
                    backgroundColor: selected ? theme.selectedHunk : theme.background,
                  }}
                  onMouseUp={(event: TuiMouseEvent) => {
                    clearTransientNotice();
                    if (event.modifiers.shift) {
                      lastClick.current = { index: -1, at: 0 };
                      void controller.select(index, viewportBodyHeight, { extend: true });
                      return;
                    }
                    const now = Date.now();
                    const shouldOpen =
                      lastClick.current.index === index && now - lastClick.current.at < 400;
                    void controller.select(index, viewportBodyHeight).then(() => {
                      if (shouldOpen) void openSelected();
                    });
                    lastClick.current = { index, at: now };
                  }}
                >
                  {projected.graphWidth ? (
                    <box
                      style={{
                        width: projected.graphWidth,
                        height: responsiveLayout.rowHeight,
                        flexDirection: "column",
                      }}
                    >
                      <HistoryGraphLine text={projected.graph} colors={graphColors} />
                      <HistoryGraphLine text={projected.continuation} colors={graphColors} />
                      <HistoryGraphLine text={projected.convergence} colors={graphColors} />
                    </box>
                  ) : null}
                  <box
                    style={{
                      width: projected.leftWidth,
                      height: responsiveLayout.rowHeight,
                      flexDirection: "column",
                    }}
                  >
                    <text fg={theme.text}>{projected.title}</text>
                    <text>
                      {projected.author ? (
                        <span fg={logPalette.author}>{projected.author}</span>
                      ) : null}
                      {projected.author && projected.relativeTime ? (
                        <span fg={logPalette.separator}> · </span>
                      ) : null}
                      {projected.relativeTime ? (
                        <span fg={logPalette.relativeTime}>{projected.relativeTime}</span>
                      ) : null}
                    </text>
                    <text> </text>
                  </box>
                  {projected.columnGap ? <box style={{ width: projected.columnGap }} /> : null}
                  <box
                    style={{
                      width: projected.rightWidth,
                      height: responsiveLayout.rowHeight,
                      flexDirection: "column",
                      alignItems: "flex-end",
                    }}
                    onMouseUp={(event: TuiMouseEvent) => {
                      event.stopPropagation();
                      clearTransientNotice();
                      const copyIconStart =
                        1 +
                        projected.graphWidth +
                        projected.leftWidth +
                        projected.columnGap +
                        projected.rightWidth -
                        measureTextWidth(projected.copyIcon);
                      if (event.modifiers.shift) {
                        lastClick.current = { index: -1, at: 0 };
                        void controller.select(index, viewportBodyHeight, { extend: true });
                        return;
                      }
                      void controller.select(index, viewportBodyHeight).then(() => {
                        if (event.x >= copyIconStart) copySelected(row);
                        else void openSelected();
                      });
                    }}
                  >
                    <box style={{ flexDirection: "row", gap: 1 }}>
                      <text fg={logPalette.commitId}>{projected.displayId}</text>
                      <text fg={logPalette.copyAction}>{projected.copyIcon}</text>
                    </box>
                    {projected.secondary ? (
                      <text fg={logPalette.decoration}>{projected.secondary}</text>
                    ) : null}
                  </box>
                </box>
              </box>
            );
          })
        )}
      </box>
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
                  ((selection?.count ?? 0) > 1
                    ? `${selection!.count} commits selected`
                    : `${runtime.providerName} · ${snapshot.rows.length}${snapshot.historyDone ? " commits" : "+ commits"}`),
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
      {parentSelectorIndex !== null && parentRow ? (
        <ParentSelectorDialog
          parentRevisionIds={parentRow.commit.parentRevisionIds}
          selectedIndex={parentSelectorIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onAccept={(index) => {
            const parent = parentRow.commit.parentRevisionIds[index];
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
      {viewPreferenceQuit.saveConfigPromptOpen ? (
        <ViewPreferenceQuitDialog
          controller={logViewPreferenceQuit}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
        />
      ) : null}
    </box>
  );
}
