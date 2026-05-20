import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { resolveBundledKittyWatcherPath } from "../core/paths";
import { detectVcs } from "../core/vcs";
import type { KittyCommandInput, KittySyncCommandInput } from "../core/types";
import {
  createHttpHunkSessionCliClient,
  stringifyJson,
  type HunkSessionCliClient,
} from "../hunk-session/cli";
import type { ListedSession } from "../hunk-session/types";

export interface KittyForegroundProcess {
  cmdline: string[];
  cwd?: string;
  pid?: number;
}

export interface KittyWindow {
  id: number;
  title?: string;
  cwd?: string;
  cmdline: string[];
  isActive: boolean;
  foregroundProcesses: KittyForegroundProcess[];
}

export interface KittyTab {
  id: number;
  isActive: boolean;
  windows: KittyWindow[];
}

export interface KittyOsWindow {
  id: number;
  isFocused: boolean;
  isActive: boolean;
  tabs: KittyTab[];
}

export interface ActiveKittyPane {
  osWindow: KittyOsWindow;
  tab: KittyTab;
  window: KittyWindow;
}

type KittySyncNoopReason =
  | "active-hunk-window"
  | "ambiguous-target"
  | "kitty-window-not-active"
  | "kitty-window-not-found"
  | "no-active-kitty-pane"
  | "no-marked-hunk-session"
  | "non-directory"
  | "not-a-repo"
  | "unchanged";

export type KittySyncResult =
  | {
      status: "noop";
      reason: KittySyncNoopReason;
      windowId?: string;
      cwd?: string;
      repoRoot?: string;
    }
  | {
      status: "reloaded";
      sessionId: string;
      windowId: string;
      cwd: string;
      repoRoot: string;
      title: string;
      fileCount: number;
    };

export interface KittySyncDeps {
  client?: HunkSessionCliClient;
  loadKittyState?: (to?: string) => Promise<KittyOsWindow[]>;
  detectRepo?: typeof detectVcs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseKittyForegroundProcess(value: unknown): KittyForegroundProcess | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const cmdline = parseStringArray(record.cmdline);
  if (cmdline.length === 0) {
    return null;
  }

  return {
    cmdline,
    cwd: parseOptionalString(record.cwd),
    pid: typeof record.pid === "number" ? record.pid : undefined,
  };
}

function parseKittyWindow(value: unknown): KittyWindow | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "number") {
    return null;
  }

  const foregroundProcesses = Array.isArray(record.foreground_processes)
    ? record.foreground_processes
        .map(parseKittyForegroundProcess)
        .filter((process): process is KittyForegroundProcess => process !== null)
    : [];

  return {
    id: record.id,
    title: parseOptionalString(record.title),
    cwd: parseOptionalString(record.cwd),
    cmdline: parseStringArray(record.cmdline),
    isActive: record.is_active === true,
    foregroundProcesses,
  };
}

function parseKittyTab(value: unknown): KittyTab | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "number" || !Array.isArray(record.windows)) {
    return null;
  }

  return {
    id: record.id,
    isActive: record.is_active === true,
    windows: record.windows
      .map(parseKittyWindow)
      .filter((window): window is KittyWindow => window !== null),
  };
}

function parseKittyOsWindow(value: unknown): KittyOsWindow | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "number" || !Array.isArray(record.tabs)) {
    return null;
  }

  return {
    id: record.id,
    isFocused: record.is_focused === true,
    isActive: record.is_active === true,
    tabs: record.tabs.map(parseKittyTab).filter((tab): tab is KittyTab => tab !== null),
  };
}

/** Parse the `kitten @ ls` window tree into the subset Hunk needs. */
export function parseKittyState(value: unknown): KittyOsWindow[] {
  return Array.isArray(value)
    ? value
        .map(parseKittyOsWindow)
        .filter((osWindow): osWindow is KittyOsWindow => osWindow !== null)
    : [];
}

/** Return all Kitty windows with their parent OS-window id for target matching. */
function flattenKittyWindows(osWindows: KittyOsWindow[]) {
  return osWindows.flatMap((osWindow) =>
    osWindow.tabs.flatMap((tab) =>
      tab.windows.map((window) => ({
        osWindowId: osWindow.id,
        window,
      })),
    ),
  );
}

/** Resolve the currently active pane and reject stale focus events. */
export function resolveActiveKittyPane(
  osWindows: KittyOsWindow[],
  expectedWindowId: string,
): ActiveKittyPane | KittySyncNoopReason {
  const expectedId = Number.parseInt(expectedWindowId, 10);
  const focusedOsWindow =
    osWindows.find((osWindow) => osWindow.isFocused) ??
    osWindows.find((osWindow) => osWindow.isActive);
  if (!focusedOsWindow) {
    return "no-active-kitty-pane";
  }

  const activeTab = focusedOsWindow.tabs.find((tab) => tab.isActive);
  const activeWindow = activeTab?.windows.find((window) => window.isActive);
  if (!activeTab || !activeWindow) {
    return "no-active-kitty-pane";
  }

  if (!Number.isFinite(expectedId)) {
    return "kitty-window-not-found";
  }

  if (!flattenKittyWindows(osWindows).some(({ window }) => window.id === expectedId)) {
    return "kitty-window-not-found";
  }

  if (activeWindow.id !== expectedId) {
    return "kitty-window-not-active";
  }

  return {
    osWindow: focusedOsWindow,
    tab: activeTab,
    window: activeWindow,
  };
}

function getKittyWindowId(session: ListedSession) {
  return session.terminal?.locations.find(
    (location) => location.source === "kitty" && location.windowId,
  )?.windowId;
}

function isHunkCommand(cmdline: string[]) {
  return cmdline.some((part) => {
    const name = basename(part).toLowerCase();
    return name === "hunk" || name === "hunkdiff" || name.startsWith("hunkdiff-");
  });
}

function isActiveHunkWindow(activeWindow: KittyWindow, sessions: ListedSession[]) {
  const activeWindowId = String(activeWindow.id);
  const matchesRegisteredHunkWindow = sessions.some(
    (session) => session.kittyFollow && getKittyWindowId(session) === activeWindowId,
  );
  if (matchesRegisteredHunkWindow) {
    return true;
  }

  return activeWindow.foregroundProcesses.some((process) => isHunkCommand(process.cmdline));
}

function resolvePaneCwd(window: KittyWindow) {
  return window.foregroundProcesses[0]?.cwd ?? window.cwd;
}

function isDirectory(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Pick the marked Hunk session that should follow the active Kitty pane. */
export function selectKittyFollowTarget(
  sessions: ListedSession[],
  osWindows: KittyOsWindow[],
  activeOsWindowId: number,
): ListedSession | KittySyncNoopReason {
  const markedSessions = sessions.filter((session) => session.kittyFollow);
  if (markedSessions.length === 0) {
    return "no-marked-hunk-session";
  }

  const windowsById = new Map(
    flattenKittyWindows(osWindows).map(({ osWindowId, window }) => [String(window.id), osWindowId]),
  );
  const sameOsWindowSessions = markedSessions.filter((session) => {
    const kittyWindowId = getKittyWindowId(session);
    return kittyWindowId ? windowsById.get(kittyWindowId) === activeOsWindowId : false;
  });

  if (sameOsWindowSessions.length === 1) {
    return sameOsWindowSessions[0]!;
  }

  if (sameOsWindowSessions.length > 1) {
    return "ambiguous-target";
  }

  return markedSessions.length === 1 ? markedSessions[0]! : "ambiguous-target";
}

async function readKittyState(to?: string) {
  const args = ["@", ...(to ? ["--to", to] : []), "ls"];
  const proc = spawnSync("kitten", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (proc.error) {
    throw proc.error;
  }

  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "`kitten @ ls` failed.");
  }

  return parseKittyState(JSON.parse(proc.stdout));
}

/** Reload one marked Hunk session from the active Kitty pane, or return a named no-op. */
export async function syncKittyFollowSession(
  input: KittySyncCommandInput,
  deps: KittySyncDeps = {},
): Promise<KittySyncResult> {
  const loadKittyState = deps.loadKittyState ?? readKittyState;
  const client = deps.client ?? createHttpHunkSessionCliClient();
  const detectRepo = deps.detectRepo ?? detectVcs;
  const osWindows = await loadKittyState(input.to);
  const activePane = resolveActiveKittyPane(osWindows, input.windowId);

  if (typeof activePane === "string") {
    return { status: "noop", reason: activePane, windowId: input.windowId };
  }

  let sessions: ListedSession[];
  try {
    sessions = await client.listSessions();
  } catch {
    return { status: "noop", reason: "no-marked-hunk-session", windowId: input.windowId };
  }
  if (isActiveHunkWindow(activePane.window, sessions)) {
    return { status: "noop", reason: "active-hunk-window", windowId: input.windowId };
  }

  const cwd = resolvePaneCwd(activePane.window);
  if (!cwd || !isDirectory(cwd)) {
    return { status: "noop", reason: "non-directory", windowId: input.windowId, cwd };
  }

  const detected = detectRepo(cwd);
  if (!detected) {
    return { status: "noop", reason: "not-a-repo", windowId: input.windowId, cwd };
  }

  const target = selectKittyFollowTarget(sessions, osWindows, activePane.osWindow.id);
  if (typeof target === "string") {
    return {
      status: "noop",
      reason: target,
      windowId: input.windowId,
      cwd,
      repoRoot: detected.repoRoot,
    };
  }

  if (target.repoRoot === detected.repoRoot) {
    return {
      status: "noop",
      reason: "unchanged",
      windowId: input.windowId,
      cwd,
      repoRoot: detected.repoRoot,
    };
  }

  const result = await client.reloadSession({
    kind: "session",
    action: "reload",
    output: "json",
    selector: { sessionId: target.sessionId },
    sourcePath: cwd,
    nextInput: {
      kind: "vcs",
      staged: false,
      options: {},
    },
  });

  return {
    status: "reloaded",
    sessionId: result.sessionId,
    windowId: input.windowId,
    cwd,
    repoRoot: detected.repoRoot,
    title: result.title,
    fileCount: result.fileCount,
  };
}

function formatKittySyncOutput(result: KittySyncResult) {
  if (result.status === "reloaded") {
    return `Reloaded Hunk session ${result.sessionId} from ${result.repoRoot}.\n`;
  }

  return `No Hunk session reloaded: ${result.reason}.\n`;
}

/** Execute one non-TUI Kitty integration command. */
export async function runKittyCommand(input: KittyCommandInput) {
  switch (input.action) {
    case "watcher-path":
      return `${resolveBundledKittyWatcherPath()}\n`;
    case "sync": {
      const result = await syncKittyFollowSession(input);
      return input.output === "json" ? stringifyJson({ result }) : formatKittySyncOutput(result);
    }
  }
}
