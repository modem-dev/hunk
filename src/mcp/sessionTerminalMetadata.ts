import type { SessionTerminalLocation, SessionTerminalMetadata } from "./types";

function trimmed(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function sameLocation(left: SessionTerminalLocation, right: SessionTerminalLocation) {
  return (
    left.source === right.source &&
    left.tty === right.tty &&
    left.windowId === right.windowId &&
    left.tabId === right.tabId &&
    left.paneId === right.paneId &&
    left.terminalId === right.terminalId &&
    left.sessionId === right.sessionId
  );
}

function pushLocation(locations: SessionTerminalLocation[], location: SessionTerminalLocation) {
  if (!locations.some((existing) => sameLocation(existing, location))) {
    locations.push(location);
  }
}

function inferLocationSource(program: string | undefined) {
  const normalized = program?.trim().toLowerCase();
  if (!normalized) {
    return "terminal";
  }

  if (normalized === "iterm.app" || normalized === "iterm2") {
    return "iterm2";
  }

  if (normalized === "ghostty") {
    return "ghostty";
  }

  if (normalized === "apple_terminal" || normalized === "apple terminal") {
    return "terminal.app";
  }

  return "terminal";
}

function parseHierarchicalIds(sessionId: string) {
  const prefix = sessionId.split(":", 1)[0]?.trim();
  if (!prefix) {
    return {};
  }

  const match = /^w(?<window>\d+)t(?<tab>\d+)(?:p(?<pane>\d+))?$/i.exec(prefix);
  if (!match?.groups) {
    return {};
  }

  return {
    windowId: match.groups.window,
    tabId: match.groups.tab,
    paneId: match.groups.pane,
  } satisfies Pick<SessionTerminalLocation, "windowId" | "tabId" | "paneId">;
}

/**
 * Capture terminal- and multiplexer-facing location metadata for one Hunk TUI session.
 *
 * The structure is intentionally generic so we can layer tmux, iTerm2, Ghostty,
 * and future terminal integrations without adding a new top-level field for each one.
 */
export function resolveSessionTerminalMetadata({
  env = process.env,
  tty,
}: {
  env?: NodeJS.ProcessEnv;
  tty?: string;
} = {}): SessionTerminalMetadata | undefined {
  const termProgram = trimmed(env.TERM_PROGRAM);
  const lcTerminal = trimmed(env.LC_TERMINAL);
  const program =
    termProgram?.toLowerCase() === "tmux" && lcTerminal ? lcTerminal : (termProgram ?? lcTerminal);
  const locations: SessionTerminalLocation[] = [];

  const ttyPath = trimmed(tty);
  if (ttyPath) {
    pushLocation(locations, { source: "tty", tty: ttyPath });
  }

  const tmuxPane = trimmed(env.TMUX_PANE);
  if (tmuxPane) {
    pushLocation(locations, { source: "tmux", paneId: tmuxPane });
  }

  const iTermSessionId = trimmed(env.ITERM_SESSION_ID);
  if (iTermSessionId) {
    pushLocation(locations, {
      source: "iterm2",
      sessionId: iTermSessionId,
      ...parseHierarchicalIds(iTermSessionId),
    });
  }

  const terminalSessionId = trimmed(env.TERM_SESSION_ID);
  if (terminalSessionId && terminalSessionId !== iTermSessionId) {
    pushLocation(locations, {
      source: inferLocationSource(program),
      sessionId: terminalSessionId,
      ...parseHierarchicalIds(terminalSessionId),
    });
  }

  if (!program && locations.length === 0) {
    return undefined;
  }

  return {
    program,
    locations,
  };
}
