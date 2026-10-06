import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { CommonOptions } from "../../core/run/commandInputs";
import type { UserKeyBinding } from "../../core/run/config";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { MenuBar } from "../components/chrome/MenuBar";
import { MenuDropdown } from "../components/chrome/MenuDropdown";
import { HelpDialog } from "../components/chrome/HelpDialog";
import { ThemeSelectorDialog } from "../components/chrome/ThemeSelectorDialog";
import type { AppMenus, MenuEntry } from "../components/chrome/menu";
import { useMenuController } from "../hooks/useMenuController";
import { useThemeSelectorController } from "../hooks/useThemeSelectorController";
import { useTimedNotice } from "../hooks/useTimedNotice";
import { dispatchAppCommand, executeAppCommand } from "../lib/appCommands";
import { APP_COMMAND_NAMES } from "../../core/run/commandCatalog";
import { HISTORY_COMMAND_NAMES } from "../../core/run/historyCommandCatalog";
import { DOCUMENT_COMMAND_CATALOG } from "../../core/run/documentCommandCatalog";
import { resolveCommandKeys } from "../lib/keymap";
import { openFileInEditor } from "../lib/openInEditor";
import { fitText } from "../lib/text";
import type { ThemeController } from "../theme/controller";
import { buildSurfaceCommands } from "../session/commands";
import { DocumentPane } from "./DocumentPane";
import { DocumentTree } from "./DocumentTree";
import type { DocumentBrowserController } from "./controller";

/** Coordinate a document surface using shared session chrome, keymaps and theme ownership. */
export function DocumentApp({
  controller,
  themeController,
  options,
  keybindings,
  onQuit,
}: {
  controller: DocumentBrowserController;
  themeController: ThemeController;
  options: CommonOptions;
  keybindings: Record<string, UserKeyBinding>;
  onQuit: () => void;
}) {
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [focus, setFocus] = useState<"tree" | "document">(
    controller.source.root.kind === "directory" ? "tree" : "document",
  );
  const [sidebar, setSidebar] = useState(
    options.sidebar !== false && controller.source.root.kind === "directory",
  );
  const [numbers, setNumbers] = useState(options.lineNumbers !== false);
  const [wrap, setWrap] = useState(options.wrapLines ?? false);
  const [help, setHelp] = useState(false);
  const notice = useTimedNotice(4000);
  const setNotice = (text: string | null) => {
    if (text === null) notice.clear();
    else notice.show(text);
  };
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const visibleLineRef = useRef(() => 1);
  const themeSelector = useThemeSelectorController({
    themeController,
    transparentBackground: options.transparentBackground ?? false,
    onTransientNotice: notice.show,
  });
  const theme = themeSelector.activeTheme;
  const treeWidth = sidebar ? Math.min(34, Math.max(12, Math.floor(terminal.width / 3))) : 0;
  const height = Math.max(1, terminal.height - 3);
  const treeFocused = sidebar && focus === "tree";
  const keys = useMemo(
    () =>
      resolveCommandKeys({
        defaults: DOCUMENT_COMMAND_CATALOG,
        userBindings: keybindings,
        inactiveCommandNames: new Set([...APP_COMMAND_NAMES, ...HISTORY_COMMAND_NAMES]),
      }),
    [keybindings],
  );

  /** Delegate selected documents to an external editor without borrowing review file types. */
  const edit = async () => {
    const key = controller.getSnapshot().documentKey;
    const path = key ? await controller.source.editablePath?.(key) : null;
    if (renderer.isDestroyed || controller.isClosed) return;
    if (!path) {
      setNotice("No editable regular file selected.");
      return;
    }
    setNotice(openFileInEditor({ filePath: path, line: visibleLineRef.current(), renderer }));
    await controller.refresh();
  };

  /** Apply navigation to the focused surface, preserving the document's independent selection. */
  const step = (delta: number) => {
    if (treeFocused) controller.move(delta);
    else scrollRef.current?.scrollBy(delta);
  };
  const commands = buildSurfaceCommands(DOCUMENT_COMMAND_CATALOG, {
    resolvedKeys: keys.keys,
    run(entry) {
      const current = controller.getSnapshot();
      const selected = current.rows.find((row) => row.entry.key === current.selectedKey)?.entry;
      switch (entry.id) {
        case "hunk.app.quit":
          onQuit();
          break;
        case "hunk.app.refresh":
          void controller.refresh();
          break;
        case "hunk.app.toggleFocusArea":
          setFocus((focus) => (focus === "tree" ? "document" : "tree"));
          break;
        case "hunk.app.toggleHelp":
          setHelp((help) => !help);
          break;
        case "hunk.view.openThemeSelector":
          themeSelector.openThemeSelector();
          break;
        case "hunk.view.toggleFilesPane":
          setSidebar((value) => !value);
          break;
        case "hunk.view.toggleLineNumbers":
          setNumbers((value) => !value);
          break;
        case "hunk.view.toggleLineWrap":
          setWrap((value) => !value);
          break;
        case "hunk.documents.toggleExcluded":
          controller.toggleExcluded();
          break;
        case "hunk.documents.activate":
          if (selected) void controller.activate(selected.key);
          break;
        case "hunk.documents.edit":
          void edit();
          break;
        case "hunk.documents.stepDown":
          step(1);
          break;
        case "hunk.documents.stepUp":
          step(-1);
          break;
        case "hunk.documents.pageDown":
          step(height - 1);
          break;
        case "hunk.documents.pageUp":
          step(1 - height);
          break;
        case "hunk.documents.jumpToTop":
          if (treeFocused) controller.move(-current.rows.length);
          else scrollRef.current?.scrollTo(0);
          break;
        case "hunk.documents.jumpToBottom":
          if (treeFocused) controller.move(current.rows.length);
          else scrollRef.current?.scrollTo(scrollRef.current.scrollHeight);
          break;
        case "hunk.documents.scrollLeft":
          if (treeFocused && selected?.kind === "directory" && current.expanded.has(selected.key))
            void controller.activate(selected.key);
          else if (!treeFocused) scrollRef.current?.scrollBy({ x: -4, y: 0 });
          break;
        case "hunk.documents.scrollRight":
          if (treeFocused && selected?.kind === "directory" && !current.expanded.has(selected.key))
            void controller.activate(selected.key);
          else if (!treeFocused) scrollRef.current?.scrollBy({ x: 4, y: 0 });
          break;
      }
    },
  });
  const menuItem = (id: string, checked?: boolean): MenuEntry => {
    const command = commands.find((command) => command.id === id)!;
    return {
      kind: "item",
      label: command.title,
      commandId: id,
      hint: command.keyLabels.join(" / "),
      checked,
      action: () => {
        executeAppCommand(commands, id);
      },
    };
  };
  const menus: AppMenus = {
    file: [
      menuItem("hunk.app.refresh"),
      menuItem("hunk.documents.edit"),
      menuItem("hunk.app.quit"),
    ],
    view: [
      menuItem("hunk.view.openThemeSelector"),
      menuItem("hunk.view.toggleFilesPane", sidebar),
      menuItem("hunk.view.toggleLineNumbers", numbers),
      menuItem("hunk.view.toggleLineWrap", wrap),
      menuItem("hunk.documents.toggleExcluded", snapshot.showExcluded),
    ],
    help: [menuItem("hunk.app.toggleHelp")],
  };
  const menu = useMenuController(menus);
  useKeyboard((key) => {
    if (help) {
      if (key.name === "escape" || key.sequence === "?") setHelp(false);
      key.preventDefault();
      return;
    }
    if (themeSelector.themeSelectorOpen) {
      if (key.name === "escape") themeSelector.closeThemeSelector();
      else if (key.name === "up") themeSelector.moveThemeSelector(-1);
      else if (key.name === "down") themeSelector.moveThemeSelector(1);
      else if (key.name === "return") themeSelector.acceptThemeSelector();
      key.preventDefault();
      return;
    }
    if (key.name === "f10") {
      if (menu.activeMenuId) menu.closeMenu();
      else menu.openMenu("file");
      key.preventDefault();
      return;
    }
    if (menu.getActiveMenuId()) {
      if (key.name === "escape") menu.closeMenu();
      else if (key.name === "left") menu.switchMenu(-1);
      else if (key.name === "right") menu.switchMenu(1);
      else if (key.name === "up") menu.moveMenuItem(-1);
      else if (key.name === "down") menu.moveMenuItem(1);
      else if (key.name === "return") menu.activateCurrentMenuItem();
      key.preventDefault();
      return;
    }
    dispatchAppCommand(commands, key);
  });
  const overlay = help || themeSelector.themeSelectorOpen || menu.activeMenuId !== null;
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <MenuBar
        activeMenuId={menu.activeMenuId}
        menuSpecs={menu.menuSpecs}
        terminalWidth={terminal.width}
        theme={theme}
        topTitle={`Open · ${sanitizeTerminalLine(controller.source.root.name)}`}
        onHoverMenu={(id) => {
          if (menu.activeMenuId) menu.openMenu(id);
        }}
        onToggleMenu={menu.toggleMenu}
      />
      <box flexGrow={1} flexDirection="row">
        {sidebar ? (
          <box
            width={treeWidth}
            height="100%"
            backgroundColor={theme.panel}
            onMouseDown={() => setFocus("tree")}
          >
            <DocumentTree
              snapshot={snapshot}
              theme={theme}
              width={treeWidth}
              height={height}
              focused={treeFocused && !overlay}
              onActivate={(key) => {
                setFocus("tree");
                void controller.activate(key);
              }}
            />
          </box>
        ) : null}
        {sidebar ? <box width={1} height="100%" backgroundColor={theme.border} /> : null}
        <box
          flexGrow={1}
          height="100%"
          flexDirection="column"
          onMouseDown={() => setFocus("document")}
        >
          <text height={1} fg={theme.accent}>
            {fitText(
              ` ${sanitizeTerminalLine(snapshot.documentEntry?.displayPath ?? snapshot.documentEntry?.name ?? "Complete document")}`,
              Math.max(1, terminal.width - treeWidth - 1),
            )}
          </text>
          <DocumentPane
            document={snapshot.document}
            documentKey={snapshot.documentKey}
            pathHint={
              snapshot.documentEntry?.displayPath ?? snapshot.documentEntry?.name ?? "document"
            }
            height={height}
            width={Math.max(1, terminal.width - treeWidth - (sidebar ? 1 : 0))}
            wrap={wrap}
            tabWidth={options.tabWidth ?? 4}
            theme={theme}
            lineNumbers={numbers}
            focused={!treeFocused && !overlay}
            scrollRef={scrollRef}
            visibleLineRef={visibleLineRef}
          />
        </box>
      </box>
      <text height={1} fg={theme.muted}>
        {fitText(
          ` ${sanitizeTerminalLine(notice.text ?? snapshot.notice ?? keys.issues[0]?.message ?? `${treeFocused ? "Tree" : "Document"} · read-only · ${snapshot.showExcluded ? "hidden/ignored shown" : "hidden/ignored hidden"}`)}`,
          terminal.width,
        )}
      </text>
      {menu.activeMenuId && menu.activeMenuSpec ? (
        <MenuDropdown
          {...menu}
          activeMenuId={menu.activeMenuId}
          activeMenuSpec={menu.activeMenuSpec}
          terminalHeight={terminal.height}
          terminalWidth={terminal.width}
          theme={theme}
          onHoverItem={menu.setActiveMenuItemIndex}
          onSelectItem={(entry) => {
            entry.action();
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
          theme={theme}
          onAcceptItem={themeSelector.acceptThemeSelectorItem}
          onClose={themeSelector.closeThemeSelector}
          onPreviewItem={themeSelector.previewThemeSelectorItem}
        />
      ) : null}
      {help ? (
        <HelpDialog
          sections={[
            {
              title: "Documents",
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
          theme={theme}
          onClose={() => setHelp(false)}
        />
      ) : null}
    </box>
  );
}
