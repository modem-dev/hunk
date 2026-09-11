import type { KeyEvent, MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { basename } from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { APP_COMMAND_NAMES } from "../../core/run/commandCatalog";
import type { PersistedViewPreferences } from "../../core/run/config";
import type {
  ExtensionVcsHistoryCommit,
  ExtensionVcsHistoryRangeSelection,
} from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { resolveExtensionCommands, resolveExtensionSessionOptions } from "../../extensions/apply";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import { CommitMetadataText } from "../components/CommitMetadataText";
import { RevisionIdControl } from "../components/RevisionIdControl";
import { ViewPreferenceQuitDialog } from "../components/chrome/ViewPreferenceQuitDialog";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import {
  useViewPreferenceQuitController,
  type ViewPreferenceQuitScheduler,
} from "../hooks/useViewPreferenceQuitController";
import { fitText, measureTextWidth } from "../lib/text";
import { handleViewPreferenceQuitPromptKey } from "../lib/viewPreferenceQuitKeys";
import type { ThemeController } from "../theme/controller";
import { StatusLine } from "../statusLine/StatusLine";
import type { StatusItem } from "../statusLine/types";
import { useStatusLine } from "../statusLine/useStatusLine";
import type { InteractiveHistoryRuntime } from "../history/types";
import type { LogController } from "./controller";
import { dispatchAppCommand, executeAppCommand, findAppCommandById } from "../lib/appCommands";
import { resolveCommandKeys } from "../lib/keymap";
import {
  buildHistoryCommands,
  buildHistoryHelpSections,
  historyCommand,
  historyCommandKeyDefaults,
  type HistoryCommandHandlers,
  type HistoryCommandId,
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
      commits: readonly ExtensionVcsHistoryCommit[];
      count: number;
      parentRevisionId?: string;
    };

/** Render the bounded history list inside Hunk's shared desktop chrome. */
export function LogApp({
  controller,
  runtime,
  onOutcome,
  sessionViewPreferences,
  themeController,
  useColor,
  quitScheduler,
}: {
  controller: LogController;
  runtime: InteractiveHistoryRuntime;
  onOutcome: (outcome: LogAppOutcome) => void | Promise<void>;
  /** Latest review preferences retained by the routed interactive session. */
  sessionViewPreferences: PersistedViewPreferences;
  themeController: ThemeController;
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
  const themeSelector = useThemeSelectorController({
    onTransientNotice: setTransientNotice,
    themeController,
    transparentBackground: false,
  });
  const { store: statusLineStore, snapshot: statusLineState } = useStatusLine();
  const terminalThemeMode = renderer.themeMode ?? "dark";
  const theme = useColor
    ? themeSelector.activeTheme
    : monochromeLogTheme(themeSelector.activeTheme, terminalThemeMode);
  const chromeTheme = useColor
    ? themeSelector.baseTheme
    : monochromeLogTheme(themeSelector.baseTheme, terminalThemeMode);
  const logPalette = resolveInteractiveLogPalette(theme);
  const graphColors = snapshot.presentation.graph ? logPalette.graphLanes : [logPalette.timeline];
  const selection = controller.getSelection();
  const parentRow = selection?.oldest;
  const responsiveLayout = resolveLogResponsiveLayout(terminal.width, terminal.height);
  const viewportBodyHeight = responsiveLayout.bodyHeight;
  const currentViewPreferences = useMemo(
    () => ({ ...sessionViewPreferences, theme: themeSelector.themeId }),
    [sessionViewPreferences, themeSelector.themeId],
  );
  const viewPreferenceQuit = useViewPreferenceQuitController({
    currentPreferences: currentViewPreferences,
    initialPreferences: {
      ...runtime.initialViewPreferences,
      theme: themeController.initialThemeId,
    },
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
        commits: controller.getSelectedRows(8).map((row) => row.commit),
        count: currentSelection.count,
        ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
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
  const inactiveHistoryCommandNames = useMemo(() => {
    const names = new Set(APP_COMMAND_NAMES);
    for (const registered of resolveExtensionCommands(runtime.extensionSession.current.registry)
      .commands) {
      names.add(`${registered.extensionId}.${registered.command.id}`);
    }
    return names;
  }, [runtime.extensionSession]);
  const historyKeymap = useMemo(
    () =>
      resolveCommandKeys({
        defaults: historyCommandKeyDefaults(),
        inactiveCommandNames: inactiveHistoryCommandNames,
        userBindings: runtime.keybindings,
      }),
    [inactiveHistoryCommandNames, runtime.keybindings],
  );
  /** Open the host prompt on the status line; Enter selects the next match of the typed query. */
  const beginSearch = () => {
    void statusLineStore
      .requestPrompt({ prefix: "/", placeholder: "search commits", initial: snapshot.search })
      .then((query) => {
        if (query !== null) void controller.search(query);
      });
  };
  const commandHandlers: HistoryCommandHandlers = {
    "hunk.history.openSelection": () => void requestOpenSelected(),
    "hunk.history.copyRevision": () => copySelected(),
    "hunk.history.refresh": () => void controller.refresh(),
    "hunk.app.quit": (key) => requestLogQuit(key.ctrl && key.name === "c" ? 130 : undefined),
    "hunk.view.openThemeSelector": () => themeSelector.openThemeSelector(),
    "hunk.history.toggleGraph": () => controller.togglePresentation("graph"),
    "hunk.history.toggleUnicode": () => controller.togglePresentation("unicode"),
    "hunk.history.toggleAuthor": () => controller.togglePresentation("author"),
    "hunk.history.toggleDate": () => controller.togglePresentation("date"),
    "hunk.history.toggleDecorations": () => controller.togglePresentation("decorations"),
    "hunk.history.startVisualSelection": () => controller.beginVisualSelection(),
    "hunk.history.clearSelection": () => void controller.clearSelection(),
    "hunk.history.previousCommit": () =>
      void controller.move(-1, viewportBodyHeight, {
        extend: controller.getSnapshot().visualSelectionActive,
      }),
    "hunk.history.nextCommit": () =>
      void controller.move(1, viewportBodyHeight, {
        extend: controller.getSnapshot().visualSelectionActive,
      }),
    "hunk.history.extendPrevious": () =>
      void controller.move(-1, viewportBodyHeight, { extend: true }),
    "hunk.history.extendNext": () => void controller.move(1, viewportBodyHeight, { extend: true }),
    "hunk.history.pageUp": () => void controller.page(-1, viewportBodyHeight),
    "hunk.history.pageDown": () => void controller.page(1, viewportBodyHeight),
    "hunk.history.halfPageUp": () => void controller.halfPage(-1, viewportBodyHeight),
    "hunk.history.halfPageDown": () => void controller.halfPage(1, viewportBodyHeight),
    "hunk.history.jumpToFirst": () => void controller.first(viewportBodyHeight),
    "hunk.history.jumpToLast": () => void controller.last(viewportBodyHeight),
    "hunk.history.search": () => beginSearch(),
    "hunk.history.nextMatch": () => void controller.findMatch(1, viewportBodyHeight),
    "hunk.history.previousMatch": () => void controller.findMatch(-1, viewportBodyHeight),
    "hunk.history.openFirstParent": () => {
      const parent = controller.getSelectedRow()?.commit.parentRevisionIds[0];
      if (parent) void openSelected(parent);
    },
    "hunk.history.openParent": () => setParentSelectorIndex(0),
    "hunk.app.toggleHelp": () => setShowHelp(true),
    "hunk.history.showAbout": () => setTransientNotice("Hunk · terminal-native code review"),
  };
  const commands = buildHistoryCommands({
    getSnapshot: controller.getSnapshot,
    handlers: commandHandlers,
    resolvedKeys: historyKeymap.keys,
  });
  const reportedKeymapIssues = useRef(new Set<string>());
  useEffect(() => {
    const unreported = historyKeymap.issues.filter(
      (issue) => !reportedKeymapIssues.current.has(issue.message),
    );
    const first = unreported[0];
    if (!first) return;
    for (const issue of unreported) reportedKeymapIssues.current.add(issue.message);
    const remaining = unreported.length - 1;
    controller.addStartupNotices([
      remaining > 0
        ? `${first.message} (+${remaining} more keybinding issue${remaining === 1 ? "" : "s"})`
        : first.message,
    ]);
  }, [controller, historyKeymap]);
  const executeCommand = (id: HistoryCommandId) => {
    clearTransientNotice();
    return executeAppCommand(commands, id);
  };
  const commandItem = (
    id: HistoryCommandId,
    options: Pick<Extract<MenuEntry, { kind: "item" }>, "checked"> = {},
  ): Extract<MenuEntry, { kind: "item" }> => {
    const definition = historyCommand(id);
    const command = findAppCommandById(commands, id)!;
    return {
      kind: "item",
      commandId: id,
      label: definition.title,
      ...(command.keyLabels.length ? { hint: command.keyLabels.join(" / ") } : {}),
      disabled: command.isEnabled ? !command.isEnabled() : false,
      action: () => executeCommand(id),
      ...options,
    };
  };
  const menus: AppMenus = {
    file: [
      commandItem("hunk.history.openSelection"),
      commandItem("hunk.history.copyRevision"),
      commandItem("hunk.history.refresh"),
      { kind: "separator" },
      commandItem("hunk.app.quit"),
    ],
    view: [
      commandItem("hunk.view.openThemeSelector"),
      { kind: "separator" },
      commandItem("hunk.history.toggleGraph", { checked: snapshot.presentation.graph }),
      commandItem("hunk.history.toggleUnicode", { checked: snapshot.presentation.unicode }),
      commandItem("hunk.history.toggleAuthor", { checked: snapshot.presentation.author }),
      commandItem("hunk.history.toggleDate", { checked: snapshot.presentation.date }),
      commandItem("hunk.history.toggleDecorations", {
        checked: snapshot.presentation.decorations,
      }),
    ],
    navigate: [
      commandItem("hunk.history.previousCommit"),
      commandItem("hunk.history.nextCommit"),
      commandItem("hunk.history.startVisualSelection"),
      commandItem("hunk.history.clearSelection"),
      commandItem("hunk.history.extendPrevious"),
      commandItem("hunk.history.extendNext"),
      commandItem("hunk.history.pageUp"),
      commandItem("hunk.history.pageDown"),
      commandItem("hunk.history.halfPageUp"),
      commandItem("hunk.history.halfPageDown"),
      commandItem("hunk.history.jumpToFirst"),
      commandItem("hunk.history.jumpToLast"),
      { kind: "separator" },
      commandItem("hunk.history.search"),
      commandItem("hunk.history.nextMatch"),
      commandItem("hunk.history.previousMatch"),
    ],
    commit: [
      commandItem("hunk.history.openSelection"),
      commandItem("hunk.history.copyRevision"),
      { kind: "separator" },
      commandItem("hunk.history.openFirstParent"),
      commandItem("hunk.history.openParent"),
    ],
    help: [commandItem("hunk.app.toggleHelp"), commandItem("hunk.history.showAbout")],
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
        const quit = findAppCommandById(commands, "hunk.app.quit");
        if (quit?.match(key) && key.ctrl && key.name === "c") {
          quit.run(key, 1);
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
          const quit = findAppCommandById(commands, "hunk.app.quit");
          if (quit?.match(key)) {
            menu.closeMenu();
            quit.run(key, 1);
          }
        }
        consume();
        return;
      }
      if (name === "f10") menu.openMenu("file");
      else {
        const quit = findAppCommandById(commands, "hunk.app.quit");
        if (quit?.match(key)) quit.run(key, 1);
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
    if (themeSelector.themeSelectorOpen) {
      if (name === "escape") themeSelector.closeThemeSelector();
      else if (name === "up") themeSelector.moveThemeSelector(-1);
      else if (name === "down" || name === "tab")
        themeSelector.moveThemeSelector(key.shift ? -1 : 1);
      else if (name === "return" || name === "enter") themeSelector.acceptThemeSelector();
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
        const command = dispatchAppCommand(commands, key);
        if (!command) return;
        menu.closeMenu();
      }
      consume();
      return;
    }
    const prompt = statusLineStore.getSnapshot().prompt;
    if (prompt) {
      // The focused status-line input owns typing, Enter, and the two-step Escape; only the
      // host's Ctrl-C escape hatch is handled here so a search can never trap the terminal.
      if (key.ctrl && name === "c") {
        statusLineStore.cancelPrompt(prompt.id);
        consume();
      }
      return;
    }
    if (name === "f10") {
      menu.openMenu("file");
      consume();
      return;
    }
    const command = dispatchAppCommand(commands, key);
    if (!command) return;
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
  const visualSelectionKey = findAppCommandById(commands, "hunk.history.startVisualSelection")
    ?.keyLabels[0];
  const statusHint =
    terminal.width >= 120
      ? `↑↓ move · ${visualSelectionKey ? `${visualSelectionKey} or ` : ""}Shift-↑↓ select · Enter open · / search · F10 menu`
      : terminal.width >= 60
        ? `${visualSelectionKey ? `${visualSelectionKey} select · ` : ""}Enter open · F10 menu`
        : "";
  const statusText =
    transientNotice ||
    snapshot.notice ||
    ((selection?.count ?? 0) > 1 || snapshot.visualSelectionActive
      ? `${selection?.count ?? 0} commit${selection?.count === 1 ? "" : "s"} selected`
      : `${runtime.providerName} · ${snapshot.rows.length}${snapshot.historyDone ? " commits" : "+ commits"}`);
  const statusItems: StatusItem[] = [
    { id: "log:status", spans: [{ text: statusText, tone: "muted" }], priority: 1 },
  ];
  if (snapshot.search) {
    statusItems.push({ id: "log:search", spans: [{ text: `/${snapshot.search}`, tone: "muted" }] });
  }
  if (statusHint) {
    statusItems.push({
      id: "log:hint",
      spans: [{ text: statusHint, tone: "muted" }],
      alignment: "right",
      priority: -1,
    });
  }
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
                    <CommitMetadataText
                      author={projected.author}
                      relativeTime={projected.relativeTime}
                      authorColor={logPalette.author}
                      separatorColor={logPalette.separator}
                      relativeTimeColor={logPalette.relativeTime}
                    />
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
                      if (event.modifiers.shift) {
                        lastClick.current = { index: -1, at: 0 };
                        void controller.select(index, viewportBodyHeight, { extend: true });
                        return;
                      }
                      const copyIconStart =
                        1 +
                        projected.graphWidth +
                        projected.leftWidth +
                        projected.columnGap +
                        projected.rightWidth -
                        measureTextWidth(projected.copyIcon);
                      void controller.select(index, viewportBodyHeight).then(() => {
                        if (event.x >= copyIconStart) copySelected(row);
                        else void openSelected();
                      });
                    }}
                  >
                    <RevisionIdControl
                      displayRevision={projected.displayId}
                      revisionColor={logPalette.commitId}
                      copyColor={logPalette.copyAction}
                      copyIcon={projected.copyIcon}
                      onRevisionClick={() => {
                        clearTransientNotice();
                        void controller
                          .select(index, viewportBodyHeight)
                          .then(() => openSelected());
                      }}
                      onShiftClick={() => {
                        clearTransientNotice();
                        lastClick.current = { index: -1, at: 0 };
                        void controller.select(index, viewportBodyHeight, { extend: true });
                      }}
                      onCopy={() => {
                        clearTransientNotice();
                        void controller
                          .select(index, viewportBodyHeight)
                          .then(() => copySelected(row));
                      }}
                    />
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
      <StatusLine
        badge={null}
        snapshot={{
          items: [...statusItems, ...statusLineState.items],
          prompt: statusLineState.prompt,
        }}
        terminalWidth={terminal.width}
        theme={theme}
        onCloseMenu={menu.closeMenu}
        onPromptCancel={statusLineStore.cancelPrompt}
        onPromptInput={statusLineStore.updatePromptValue}
        onPromptSubmit={statusLineStore.submitPrompt}
      />
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
      {themeSelector.themeSelectorOpen ? (
        <ThemeSelectorDialog
          items={themeSelector.themeSelectorItems}
          selectedIndex={themeSelector.themeSelectorSelectedIndex}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onAcceptItem={themeSelector.acceptThemeSelectorItem}
          onClose={themeSelector.closeThemeSelector}
          onPreviewItem={themeSelector.previewThemeSelectorItem}
        />
      ) : null}
      {showHelp ? (
        <HelpDialog
          sections={buildHistoryHelpSections(commands)}
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
