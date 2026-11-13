/** @jsxImportSource react */
/**
 * Owns the page's finding tools: the command palette, go-to-file, the help overlay, and deep
 * links with browser history.
 *
 * Triggers that converge here: Ctrl/Cmd+K (palette), Ctrl/Cmd+P (go to file), `?` (help, the
 * catalog's toggle-help command), the page's own `hunk.web.*` commands from the palette, the
 * sidebar's file clicks, the browser's back and forward buttons, and a link opened with
 * `#at=<address>`. Commands still run through the page's command table (`ReviewApp`); this
 * hook only lists and launches them, and runs the page-only ones itself.
 *
 * History: navigating (keys, scrolling, clicks inside the stream) rewrites the current entry
 * with `history.replaceState`, so the address bar always names where the reader is; a
 * deliberate jump (go-to-file, a sidebar file, a link) adds an entry with `pushState`, so Back
 * returns to where the reader came from. The fragment's address is resolved once the document
 * arrives, before the page writes its own position, so the link's target wins over the first
 * hunk. The capability is never written here (`session/capability.ts` owns it).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReviewAddress } from "../../core/review/address";
import { formatReviewSidebarStat, reviewFileChangeGlyph } from "../../core/review/fileLabels";
import type { WebKeymap } from "../commands/keyboard";
import type { WebCommand } from "../commands/webCommandTable";
import { matchWebLocalChord, type WebLocalCommandId } from "../commands/webLocalCommands";
import type { ReviewFileIndexEntry } from "../mirror/fileIndex";
import {
  fragmentWithAddress,
  readFragmentAddress,
  resolveReviewAddress,
  selectionAddress,
} from "../navigation/deepLink";
import { noteSaveChordLabel } from "../notes/NoteComposerView";
import { rankFuzzy } from "../palette/fuzzy";
import { HelpOverlay } from "../palette/HelpOverlay";
import {
  buildPaletteEntries,
  buildWebHelpSections,
  rankPaletteEntries,
  rememberRecentCommand,
  webLocalHelpRows,
  type PaletteEntry,
} from "../palette/paletteEntries";
import { PickerDialog } from "../palette/PickerDialog";
import { reviewLinkWithCapability } from "../session/capability";
import type { ReviewSession } from "../session/reviewSession";
import type { ReviewRevealPoint } from "../stream/ReviewStream";

/** Where the palette keeps this browser's recent commands (ids only, no review data). */
const RECENT_COMMANDS_KEY = "hunk.review.recentCommands";

/** Read this browser's recent command ids. */
function readRecents(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Store this browser's recent command ids. */
function storeRecents(recents: readonly string[]) {
  try {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recents));
  } catch {
    // Recents are a convenience; a refused write only loses the ordering.
  }
}

type ReviewTool = "palette" | "goToFile" | "help";

export interface ReviewToolsOptions {
  session: ReviewSession;
  commands: readonly WebCommand[];
  keymap: WebKeymap;
  /** The files the shared filter leaves visible, in review order. */
  entries: readonly ReviewFileIndexEntry[];
  /** True once the shown document has files. */
  documentReady: boolean;
  setRevealPoint: (point: ReviewRevealPoint | undefined) => void;
  copyReviewLink: () => Promise<boolean>;
  chooseSessionTheme: () => void;
  setSidebarMode: (mode: "tree" | "flat") => void;
}

/** The page's palette, go-to-file, help, and deep links. */
export function useReviewTools(options: ReviewToolsOptions) {
  const { session, commands, keymap, entries, documentReady } = options;
  const [tool, setTool] = useState<ReviewTool | undefined>(undefined);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const returnFocus = useRef<HTMLElement | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const open = useCallback((next: ReviewTool) => {
    setTool((current) => {
      if (current === next) return undefined;
      if (!current) returnFocus.current = document.activeElement as HTMLElement | null;
      return next;
    });
  }, []);
  const close = useCallback(() => {
    setTool(undefined);
    const target = returnFocus.current;
    returnFocus.current = null;
    // After the dialog unmounts, give focus back to what had it.
    queueMicrotask(() => target?.focus?.());
  }, []);

  // Deep links: what to show, and keeping the address bar current.
  const resolvedInitial = useRef(false);
  const show = useCallback(
    (address: ReviewAddress) => {
      const state = session.review.store.getSnapshot();
      const target = resolveReviewAddress(state, address);
      if (!target) return false;
      if (address.kind === "file") {
        session.review.apply({
          type: "selection/select-file",
          fileKey: target.fileKey,
          reveal: { anchor: "file-top", scrollToNote: false },
        });
        return true;
      }
      latest.current.setRevealPoint(
        target.line !== undefined && target.side !== undefined
          ? { fileKey: target.fileKey, side: target.side, line: target.line }
          : target.noteId !== undefined
            ? { fileKey: target.fileKey, noteId: target.noteId }
            : undefined,
      );
      session.review.apply({
        type: "selection/select",
        fileKey: target.fileKey,
        hunkIndex: target.hunkIndex,
        reveal: { anchor: "hunk", scrollToNote: target.noteId !== undefined },
        ...(target.noteId !== undefined ? { activeNoteId: target.noteId } : {}),
      });
      return true;
    },
    [session],
  );

  /** Write the address into the current history entry, or a new one. */
  const writeAddress = useCallback(
    (address: ReviewAddress | undefined, mode: "replace" | "push") => {
      const { pathname, search, hash } = window.location;
      const next = fragmentWithAddress(hash, address);
      if (next === hash || (next === "" && hash === "")) return;
      const url = `${pathname}${search}${next}`;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [],
  );

  /** A deliberate jump: a new history entry, then the move. */
  const jumpTo = useCallback(
    (address: ReviewAddress) => {
      writeAddress(address, "push");
      show(address);
    },
    [show, writeAddress],
  );

  // Resolve the link's address once the document has arrived; until then the page does not
  // write its own position, so the first hunk never replaces the link's target.
  useEffect(() => {
    if (!documentReady || resolvedInitial.current) return;
    resolvedInitial.current = true;
    const address = readFragmentAddress(window.location.hash);
    if (address && !show(address)) {
      session.toasts.show("This link points at a place this review does not have.", "info");
    }
  }, [documentReady, session, show]);

  // Navigation rewrites the current entry so the address names where the reader is.
  useEffect(
    () =>
      session.review.store.subscribe(() => {
        if (!resolvedInitial.current) return;
        writeAddress(selectionAddress(session.review.store.getSnapshot()), "replace");
      }),
    [session, writeAddress],
  );

  // Back and forward show the entry's address.
  useEffect(() => {
    const onPopState = () => {
      const address = readFragmentAddress(window.location.hash);
      if (address) show(address);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [show]);

  const copyLocationLink = useCallback(async () => {
    const address = selectionAddress(session.review.store.getSnapshot());
    const { origin, pathname, hash } = window.location;
    try {
      await navigator.clipboard.writeText(
        reviewLinkWithCapability(
          { origin, pathname, hash: fragmentWithAddress(hash, address) },
          session.capability,
        ),
      );
      session.toasts.show("Link copied.", "info");
    } catch {
      session.toasts.show("The browser did not allow copying the link.");
    }
  }, [session]);

  /** Run one page-only command. */
  const runLocal = useCallback(
    (id: WebLocalCommandId) => {
      const current = latest.current;
      switch (id) {
        case "hunk.web.commandPalette":
          open("palette");
          return;
        case "hunk.web.goToFile":
          open("goToFile");
          return;
        case "hunk.web.copyReviewLink":
          void current
            .copyReviewLink()
            .then((copied) =>
              session.toasts.show(
                copied ? "Review link copied." : "The browser did not allow copying the link.",
                copied ? "info" : "error",
              ),
            );
          return;
        case "hunk.web.copyLocationLink":
          void copyLocationLink();
          return;
        case "hunk.web.useSessionTheme":
          current.chooseSessionTheme();
          return;
        case "hunk.web.filesAsTree":
          current.setSidebarMode("tree");
          return;
        case "hunk.web.filesAsList":
          current.setSidebarMode("flat");
          return;
      }
    },
    [copyLocationLink, open, session],
  );

  // The page's own chords; matched before the browser's (Ctrl/Cmd+P would print).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = matchWebLocalChord(event);
      if (!id) return;
      event.preventDefault();
      runLocal(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runLocal]);

  const paletteEntries = useMemo(() => buildPaletteEntries(commands, keymap), [commands, keymap]);
  const rankCommands = useCallback(
    (items: readonly PaletteEntry[], query: string) => rankPaletteEntries(items, query, recents),
    [recents],
  );
  const runEntry = useCallback(
    (entry: PaletteEntry) => {
      const next = rememberRecentCommand(recents, entry.id);
      setRecents(next);
      storeRecents(next);
      close();
      const command = commands.find((candidate) => candidate.entry.id === entry.id);
      // Run after focus returns, so a command that focuses something (the filter) keeps it.
      queueMicrotask(() => {
        if (command) command.run({ count: 1, shift: false });
        else runLocal(entry.id as WebLocalCommandId);
      });
    },
    [close, commands, recents, runLocal],
  );

  const rankFiles = useCallback(
    (items: readonly ReviewFileIndexEntry[], query: string) =>
      rankFuzzy(items, query, (entry) => [
        entry.path,
        ...(entry.previousPath ? [entry.previousPath] : []),
      ]),
    [],
  );

  const helpSections = useMemo(
    () =>
      buildWebHelpSections(keymap, [
        ...webLocalHelpRows(),
        { keys: noteSaveChordLabel(), description: "save the note being written" },
      ]),
    [keymap],
  );

  let overlay: ReactNode = null;
  if (tool === "palette") {
    overlay = (
      <PickerDialog
        label="Command palette"
        placeholder="Type a command"
        testId="command-palette"
        items={paletteEntries}
        rank={rankCommands}
        itemKey={(entry) => entry.id}
        empty="No matching commands."
        renderItem={(entry) => (
          <>
            <span className="picker-title">{entry.title}</span>
            <span className="picker-category">{entry.category}</span>
            {entry.keys ? <kbd className="picker-keys">{entry.keys}</kbd> : null}
          </>
        )}
        onPick={runEntry}
        onClose={close}
      />
    );
  } else if (tool === "goToFile") {
    overlay = (
      <PickerDialog
        label="Go to file"
        placeholder="Type a file name"
        testId="go-to-file"
        items={entries}
        rank={rankFiles}
        itemKey={(entry) => entry.key}
        empty="No matching files."
        renderItem={(entry) => {
          const glyph = reviewFileChangeGlyph(entry.changeKind, entry.flags.untracked);
          return (
            <>
              <span className="file-glyph" data-role={glyph.role}>
                {glyph.glyph}
              </span>
              <span className="picker-title">{entry.path}</span>
              <span className="picker-stats">
                <span className="stat-add">
                  {formatReviewSidebarStat("+", entry.stats.additions, entry.stats.truncated)}
                </span>{" "}
                <span className="stat-del">
                  {formatReviewSidebarStat("-", entry.stats.deletions)}
                </span>
              </span>
            </>
          );
        }}
        onPick={(entry) => {
          close();
          jumpTo({ kind: "file", fileKey: entry.key });
        }}
        onClose={close}
      />
    );
  } else if (tool === "help") {
    overlay = <HelpOverlay sections={helpSections} onClose={close} />;
  }

  return {
    overlay,
    toggleHelp: useCallback(() => open("help"), [open]),
    /** Jump to one file from the sidebar, as a new history entry. */
    jumpToFile: useCallback((fileKey: string) => jumpTo({ kind: "file", fileKey }), [jumpTo]),
  };
}
