import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PersistedViewPreferences } from "../../core/run/config";
import { APP_COMMAND_NAMES } from "../../core/run/commandCatalog";
import { HISTORY_COMMAND_CATALOG } from "../../core/run/historyCommandCatalog";
import { resolveExtensionCommands, resolveExtensionSessionOptions } from "../../extensions/apply";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { ViewPreferenceQuitDialog } from "../components/chrome/ViewPreferenceQuitDialog";
import {
  useViewPreferenceQuitController,
  type ViewPreferenceQuitScheduler,
} from "../hooks/useViewPreferenceQuitController";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import { dispatchAppCommand, executeAppCommand } from "../lib/appCommands";
import { resolveCommandKeys } from "../lib/keymap";
import { fitText } from "../lib/text";
import { handleViewPreferenceQuitPromptKey } from "../lib/viewPreferenceQuitKeys";
import { interactiveLogUsesColor, monochromeLogTheme } from "../log/colorPolicy";
import type { ThemeController } from "../theme/controller";
import { STATUS_COMMANDS, buildStatusCommands, type StatusCommandId } from "./commands";
import type { StatusController } from "./controller";
import { moveStatusFocus, planStatusViewport, projectStatusRows } from "./geometry";
import { formatStatusUpstream, statusDisplayText, statusTextColor } from "./staticProjection";
import type { StatusRuntime } from "./types";

export type StatusOutcome =
  | { kind: "quit" }
  | { kind: "cancel-prepare" }
  | { kind: "open-log" }
  | { kind: "open-review"; actionId: string; filePath?: string };

/** Render one workspace compass with sibling inspection and normal Hunk menus, never a file inspector. */
export function StatusApp({
  controller,
  runtime,
  themeController,
  sessionViewPreferences,
  onOutcome,
  quitScheduler,
}: {
  controller: StatusController;
  runtime: StatusRuntime;
  themeController: ThemeController;
  sessionViewPreferences: PersistedViewPreferences;
  onOutcome: (outcome: StatusOutcome) => void | Promise<void>;
  quitScheduler?: ViewPreferenceQuitScheduler;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const terminal = useTerminalDimensions();
  const [showHelp, setShowHelp] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const lastClick = useRef({ id: "", at: 0 });
  const themeSelector = useThemeSelectorController({
    themeController,
    transparentBackground: runtime.launchOptions.transparentBackground ?? false,
    onTransientNotice: (notice) => controller.setNotice(notice),
  });
  const useColor = interactiveLogUsesColor(runtime.input.color, process.env);
  const theme = useColor
    ? themeSelector.activeTheme
    : monochromeLogTheme(themeSelector.activeTheme, themeController.themeMode ?? "dark");
  const chromeTheme = useColor
    ? themeSelector.baseTheme
    : monochromeLogTheme(themeSelector.baseTheme, themeController.themeMode ?? "dark");
  const preferences = useMemo(
    () => ({ ...sessionViewPreferences, theme: themeSelector.themeId }),
    [sessionViewPreferences, themeSelector.themeId],
  );
  const quit = useViewPreferenceQuitController({
    currentPreferences: preferences,
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
      void onOutcome({ kind: "quit" });
    },
    showNotice: (notice) => controller.setNotice(notice),
    showError: (notice) => controller.setNotice(notice),
    closeHelp: () => setShowHelp(false),
    homeDirectory: process.env.HOME,
    quitScheduler,
  });
  const snapshot = state.snapshot;
  const rows = useMemo(() => projectStatusRows(state, terminal.width), [state, terminal.width]);
  const navigable = rows.filter((row) => row.kind !== "heading");
  const selected = rows.find((row) => row.id === state.selected);
  const hasAction = (id: string) => snapshot.reviewActions.some((action) => action.id === id);
  const open = async (outcome: StatusOutcome) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onOutcome(outcome);
    } catch (error) {
      controller.setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const inspect = async (path: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await controller.inspect(path);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const openSelection = () => {
    const current = controller.getSnapshot();
    const visible = projectStatusRows(current, terminal.width).find(
      (row) => row.id === current.selected,
    );
    if (!visible || visible.disabled) return;
    if (visible.group) {
      controller.togglePathGroup(visible.group);
      return;
    }
    const id = visible.id;
    if (id?.startsWith("worktree:") && snapshot.siblings.state === "ready") {
      const sibling = snapshot.siblings.value.worktrees.find(
        (row) => `worktree:${row.worktree.id}` === id,
      );
      if (sibling?.inspectable) void inspect(sibling.worktree.path);
    } else if (id?.startsWith("path:")) {
      const path = snapshot.paths.find((path) => `path:${path.path}` === id);
      if (!path) return;
      const action =
        path?.worktree !== "unchanged" && hasAction("unstaged")
          ? "unstaged"
          : hasAction("staged")
            ? "staged"
            : snapshot.reviewActions[0]?.id;
      if (action) void open({ kind: "open-review", actionId: action, filePath: path?.path });
    }
  };
  const move = (delta: number) => {
    const current = controller.getSnapshot();
    const next = moveStatusFocus(rows, current.selected, current.top, bodyHeight, delta);
    controller.select(next.selected, next.top);
  };
  const requestBack = async () => {
    if (pendingRef.current) {
      await onOutcome({ kind: "cancel-prepare" });
      await controller.suspend();
      controller.resume();
      return;
    }
    if (state.backPath) await controller.back();
    else quit.requestQuit();
  };
  const keymap = useMemo(
    () =>
      resolveCommandKeys({
        defaults: STATUS_COMMANDS,
        inactiveCommandNames: new Set([
          ...APP_COMMAND_NAMES,
          ...HISTORY_COMMAND_CATALOG.map((entry) => entry.id),
          ...resolveExtensionCommands(runtime.extensionSession.current.registry).commands.map(
            (entry) => `${entry.extensionId}.${entry.command.id}`,
          ),
        ]),
        userBindings: runtime.keybindings,
      }),
    [runtime],
  );
  useEffect(() => {
    if (keymap.issues.length)
      controller.setNotice(keymap.issues.map((issue) => issue.message).join(" · "));
  }, [controller, keymap]);
  const commands = buildStatusCommands(
    {
      "hunk.status.openSelection": openSelection,
      "hunk.status.togglePathGroup": () => {
        if (selected?.group) controller.togglePathGroup(selected.group);
      },
      "hunk.status.reviewStaged": () => {
        void open({ kind: "open-review", actionId: "staged" });
      },
      "hunk.status.reviewUnstaged": () => {
        void open({ kind: "open-review", actionId: "unstaged" });
      },
      "hunk.status.openLog": () => {
        void open({ kind: "open-log" });
      },
      "hunk.status.refresh": () => {
        void controller.refresh();
      },
      "hunk.status.back": () => {
        void requestBack();
      },
      "hunk.status.previousRow": () => move(-1),
      "hunk.status.nextRow": () => move(1),
      "hunk.status.pageUp": () => move(-Math.max(1, terminal.height - 7)),
      "hunk.status.pageDown": () => move(Math.max(1, terminal.height - 7)),
      "hunk.status.toggleWorktrees": () => controller.toggleWorktrees(),
      "hunk.view.openThemeSelector": themeSelector.openThemeSelector,
      "hunk.app.toggleHelp": () => setShowHelp(true),
      "hunk.app.quit": () => {
        void requestBack();
      },
    },
    keymap.keys,
    (id) => {
      if (id === "hunk.app.quit" || id === "hunk.status.back") return true;
      if (pending) return false;
      if (id === "hunk.status.reviewStaged") return hasAction("staged");
      if (id === "hunk.status.reviewUnstaged") return hasAction("unstaged");
      if (id === "hunk.status.togglePathGroup") return Boolean(selected?.group);
      if (id === "hunk.status.openSelection")
        return Boolean(
          selected &&
          !selected.disabled &&
          (selected.kind === "toggle" ||
            selected.kind === "worktree" ||
            snapshot.reviewActions.length),
        );
      return true;
    },
  );
  const commandItem = (id: StatusCommandId): Extract<MenuEntry, { kind: "item" }> => {
    const command = commands.find((command) => command.id === id)!;
    return {
      kind: "item",
      commandId: id,
      label:
        id === "hunk.app.quit" && state.backPath ? "Back to originating worktree" : command.title,
      hint: command.keyLabels.join(" / "),
      disabled: !command.isEnabled?.(),
      action: () => {
        executeAppCommand(commands, id);
      },
    };
  };
  const menus: AppMenus = {
    file: [
      commandItem("hunk.status.openSelection"),
      ...snapshot.reviewActions.map((action) => ({
        kind: "item" as const,
        label: statusDisplayText(action.label),
        disabled: pending,
        action: () => {
          void open({ kind: "open-review", actionId: action.id });
        },
      })),
      commandItem("hunk.status.openLog"),
      commandItem("hunk.status.refresh"),
      commandItem("hunk.app.quit"),
    ],
    view: [commandItem("hunk.view.openThemeSelector"), commandItem("hunk.status.toggleWorktrees")],
    navigate: [
      commandItem("hunk.status.previousRow"),
      commandItem("hunk.status.nextRow"),
      commandItem("hunk.status.back"),
    ],
    help: [commandItem("hunk.app.toggleHelp")],
  };
  const menu = useMenuController(menus);
  useEffect(() => {
    controller.resume();
    return () => {
      void controller.suspend();
    };
  }, [controller]);
  const operation =
    snapshot.operations.state === "ready"
      ? snapshot.operations.value.join(" · ")
      : "Operation state unavailable";
  const conflicts = snapshot.paths.filter((path) => path.conflict).length;
  const interruption = [
    operation,
    conflicts ? `${conflicts} conflicted path${conflicts === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const menuVisible = preferences.showMenuBar || Boolean(menu.activeMenuId);
  const headerHeight = (menuVisible ? 1 : 0) + 3 + (interruption ? 1 : 0);
  const bodyHeight = Math.max(1, terminal.height - headerHeight - 1);
  const viewport = planStatusViewport(rows, state.selected, state.top, bodyHeight);
  useEffect(() => {
    const chosen = navigable.some((row) => row.id === state.selected)
      ? state.selected
      : (navigable[0]?.id ?? null);
    if (chosen !== state.selected || viewport.top !== state.top)
      controller.select(chosen, viewport.top);
  }, [controller, navigable, state.selected, state.top, viewport.top]);
  useKeyboard((key) => {
    const consume = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (quit.saveConfigPromptOpen) {
      handleViewPreferenceQuitPromptKey(key, quit);
      consume();
      return;
    }
    if (themeSelector.themeSelectorOpen) {
      if (key.name === "escape") themeSelector.closeThemeSelector();
      else if (key.name === "up") themeSelector.moveThemeSelector(-1);
      else if (key.name === "down" || key.name === "tab")
        themeSelector.moveThemeSelector(key.shift ? -1 : 1);
      else if (key.name === "return" || key.name === "enter") themeSelector.acceptThemeSelector();
      consume();
      return;
    }
    if (showHelp) {
      if (key.name === "escape" || key.name === "q") setShowHelp(false);
      consume();
      return;
    }
    if (menu.activeMenuId) {
      if (key.name === "escape") menu.closeMenu();
      else if (key.name === "left") menu.switchMenu(-1);
      else if (key.name === "right" || key.name === "tab") menu.switchMenu(1);
      else if (key.name === "up") menu.moveMenuItem(-1);
      else if (key.name === "down") menu.moveMenuItem(1);
      else if (key.name === "return" || key.name === "enter") menu.activateCurrentMenuItem();
      else if (dispatchAppCommand(commands, key)) menu.closeMenu();
      consume();
      return;
    }
    if (key.name === "f10") {
      menu.openMenu("file");
      consume();
      return;
    }
    if (dispatchAppCommand(commands, key)) consume();
  });
  const head =
    snapshot.head.kind === "detached"
      ? `detached ${snapshot.head.revisionId.slice(0, 12)}`
      : `${snapshot.head.name}${snapshot.head.kind === "unborn" ? " (unborn)" : ""}`;
  const attention =
    snapshot.siblings.state === "ready"
      ? `Other worktrees: ${snapshot.siblings.value.worktrees.length}${snapshot.siblings.value.worktrees.some((row) => row.status.state !== "ready" || row.status.changedPathCount || row.status.operations.state !== "ready" || row.status.operations.value.length) ? " · attention" : ""}`
      : `Other worktrees: ${snapshot.siblings.state}`;
  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.background,
      }}
    >
      {menuVisible ? (
        <MenuBar
          activeMenuId={menu.activeMenuId}
          menuSpecs={menu.menuSpecs}
          terminalWidth={terminal.width}
          theme={theme}
          topTitle="Workspace status"
          onHoverMenu={(id) => {
            if (menu.activeMenuId) menu.openMenu(id);
          }}
          onToggleMenu={menu.toggleMenu}
        />
      ) : null}
      <text fg={theme.accent}>
        {fitText(statusDisplayText(`${head} · ${snapshot.worktree.path}`), terminal.width)}
      </text>
      <text fg={theme.muted}>
        {fitText(formatStatusUpstream(snapshot.upstream), terminal.width)}
      </text>
      {interruption ? <text fg={theme.accent}>{fitText(interruption, terminal.width)}</text> : null}
      <box style={{ height: 1, flexDirection: "row", gap: 2 }}>
        {snapshot.reviewActions.map((action) => (
          <text
            key={action.id}
            fg={pending ? theme.muted : theme.accent}
            onMouseUp={() => {
              if (!pending) void open({ kind: "open-review", actionId: action.id });
            }}
          >
            {statusDisplayText(
              terminal.width < 65 && (action.id === "staged" || action.id === "unstaged")
                ? action.id === "staged"
                  ? "Staged"
                  : "Unstaged"
                : action.label,
            )}
          </text>
        ))}
        {state.backPath ? (
          <text
            fg={theme.accent}
            onMouseUp={() => {
              void requestBack();
            }}
          >
            Back
          </text>
        ) : null}
      </box>
      <box
        style={{
          height: bodyHeight,
          width: "100%",
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
        }}
        onMouseScroll={(event) => {
          if (!pending) move(event.scroll?.direction === "up" ? -3 : 3);
        }}
      >
        {viewport.lines.map(({ row, spans, offset }) => (
          <text
            key={`${row.id}:${offset}`}
            fg={theme.text}
            bg={row.id === state.selected ? theme.selectedHunk : theme.background}
            onMouseUp={() => {
              menu.closeMenu();
              if (pending) return;
              if (row.id === "more" || row.id === "worktrees") {
                controller.toggleWorktrees();
                return;
              }
              if (row.group) {
                controller.togglePathGroup(row.group);
                return;
              }
              if (row.kind === "heading") return;
              controller.select(row.id);
              const now = Date.now();
              if (
                lastClick.current.id === row.id &&
                now - lastClick.current.at < 400 &&
                !row.disabled
              )
                openSelection();
              lastClick.current = { id: row.id, at: now };
            }}
          >
            {spans.map((span, index) => (
              <span key={index} fg={statusTextColor(theme, span.role)}>
                {span.text}
              </span>
            ))}
          </text>
        ))}
      </box>
      <text fg={theme.muted} bg={theme.panelAlt}>
        {fitText(
          statusDisplayText(
            pending
              ? "Preparing… · Q cancel"
              : state.notice ||
                  `${state.loading || state.siblingsLoading ? "Refreshing… · " : ""}${attention} · F10 menu`,
          ),
          terminal.width,
        )}
      </text>
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
          onSelectItem={(entry) => {
            if (!entry.disabled) entry.action();
            menu.closeMenu();
          }}
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
          sections={[
            {
              title: "Workspace status",
              rows: commands
                .filter((command) => command.keyLabels.length)
                .map((command) => ({
                  keys: command.keyLabels.join(" / "),
                  description: command.title,
                })),
            },
          ]}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
          onClose={() => setShowHelp(false)}
        />
      ) : null}
      {quit.saveConfigPromptOpen ? (
        <ViewPreferenceQuitDialog
          controller={quit}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={chromeTheme}
        />
      ) : null}
    </box>
  );
}
