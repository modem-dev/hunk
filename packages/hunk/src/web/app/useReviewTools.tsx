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
 * returns to where the reader came from (the entry being left is written first). A line link
 * keeps its line address while the selection it made stands. The fragment's address is
 * resolved once its target arrives, before the page writes its own position, so the link's
 * target wins over the first hunk; it is reported missing only once the document is complete.
 * A target the page does not show is named with its reason (`deepLink.ts`). The capability is
 * never written here (`session/capability.ts` owns it).
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
  reviewAddressHiddenMessage,
  reviewAddressHiddenReason,
  reviewLinePlacement,
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

/**
 * What a copied link grants, appended to both copy confirmations: every review link carries
 * this tab's capability, as the toolbar's "Copy link" tooltip says.
 */
const COPIED_LINK_GRANTS_ACCESS =
  "It includes this review's access key: anyone who can reach this machine's Hunk daemon can use it to open and write to this review.";

type ReviewTool = "palette" | "goToFile" | "help";

export interface ReviewToolsOptions {
  session: ReviewSession;
  commands: readonly WebCommand[];
  keymap: WebKeymap;
  /** The files the shared filter leaves visible, in review order. */
  entries: readonly ReviewFileIndexEntry[];
  setRevealPoint: (point: ReviewRevealPoint | undefined) => void;
  copyReviewLink: () => Promise<boolean>;
  chooseSessionTheme: () => void;
  setSidebarMode: (mode: "tree" | "flat") => void;
  /** Handlers for page commands another part of the page owns (the side panel's tools). */
  localHandlers?: Partial<Record<WebLocalCommandId, () => void>>;
  /** Opens a file the stream shows collapsed (a viewed file), so a link can show its content. */
  expandFile?: (fileKey: string) => void;
}

/** The page's palette, go-to-file, help, and deep links. */
export function useReviewTools(options: ReviewToolsOptions) {
  const { session, commands, keymap, entries } = options;
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
  // A line link keeps its own address in the bar while the selection is still the one it
  // made; the selection alone can only name the line's hunk.
  const linkedLine = useRef<
    { address: ReviewAddress; fileKey: string; hunkIndex: number } | undefined
  >(undefined);
  const show = useCallback(
    (address: ReviewAddress) => {
      const state = session.review.store.getSnapshot();
      const target = resolveReviewAddress(state, address);
      if (!target) return false;
      const file = state.document.files.find((candidate) => candidate.key === target.fileKey)!;
      linkedLine.current = undefined;

      // A target the page does not show is named with its reason; shared state stays as it is.
      const hidden = reviewAddressHiddenReason(state, address, session.review.hiddenFiles());
      if (hidden) {
        session.toasts.show(reviewAddressHiddenMessage(hidden, file.path), "info");
        return true;
      }
      // A viewed file collapsed in the stream opens, so the link shows its content.
      latest.current.expandFile?.(target.fileKey);

      if (address.kind === "file") {
        session.review.apply({
          type: "selection/select-file",
          fileKey: target.fileKey,
          reveal: { anchor: "file-top", scrollToNote: false },
        });
        return true;
      }

      // A linked line inside a collapsed gap is drawn by expanding the gap; a line no hunk or
      // gap holds is reported, and the link lands on the hunk's top.
      let line = target.line !== undefined && target.side !== undefined;
      if (target.line !== undefined && target.side !== undefined) {
        const placement = reviewLinePlacement(file, target.side, target.line);
        const expanded = state.expandedGaps.some(
          (gap) =>
            gap.fileKey === file.key &&
            placement.kind === "gap" &&
            gap.gapId === placement.gapId &&
            gap.expanded,
        );
        if (placement.kind === "gap" && !expanded) {
          session.review.apply({
            type: "expansion/toggle",
            fileKey: file.key,
            gapId: placement.gapId,
          });
        } else if (placement.kind === "absent") {
          line = false;
          session.toasts.show(
            `Line ${target.line} of ${file.path} is not in this diff; showing the nearest hunk.`,
            "info",
          );
        }
      }
      latest.current.setRevealPoint(
        line
          ? { fileKey: target.fileKey, side: target.side!, line: target.line! }
          : target.noteId !== undefined
            ? { fileKey: target.fileKey, noteId: target.noteId }
            : undefined,
      );
      // Set before the selection lands, so the address written for it is the line's.
      if (address.kind === "line" && line) {
        linkedLine.current = { address, fileKey: target.fileKey, hunkIndex: target.hunkIndex };
      }
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

  /** The address of where the reader is, keeping a line link while its selection stands. */
  const currentAddress = useCallback(() => {
    const state = session.review.store.getSnapshot();
    const linked = linkedLine.current;
    if (
      linked &&
      !state.activeNoteId &&
      state.selection.fileKey === linked.fileKey &&
      state.selection.hunkIndex === linked.hunkIndex
    ) {
      return linked.address;
    }
    linkedLine.current = undefined;
    return selectionAddress(state);
  }, [session]);

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
      // The entry being left names where the reader was, so Back returns there even when
      // nothing has rewritten it since the page opened.
      if (resolvedInitial.current) writeAddress(currentAddress(), "replace");
      writeAddress(address, "push");
      show(address);
    },
    [currentAddress, show, writeAddress],
  );

  // Resolve the link's address once its target has arrived; until then the page does not
  // write its own position, so the first hunk never replaces the link's target. A target
  // still loading is waited for; it is reported missing only once the document is complete
  // (and, for a note, once that generation's shared state is in).
  useEffect(() => {
    let resolving = false;
    const attempt = () => {
      // Showing the target changes the store, which calls back in here.
      if (resolvedInitial.current || resolving) return;
      const address = readFragmentAddress(window.location.hash);
      if (!address) {
        if (session.review.store.getSnapshot().document.files.length > 0) {
          resolvedInitial.current = true;
        }
        return;
      }
      resolving = true;
      const shown = show(address);
      resolving = false;
      if (shown) {
        resolvedInitial.current = true;
        return;
      }
      const mirror = session.mirror.getSnapshot();
      const sharedGeneration = session.shared.getSnapshot().body?.state.generation;
      const complete =
        mirror.status === "ready" &&
        !mirror.updating &&
        (address.kind !== "note" || sharedGeneration === mirror.address?.generation);
      if (!complete) return;
      resolvedInitial.current = true;
      session.toasts.show("This link points at a place this review does not have.", "info");
    };
    attempt();
    const stops = [
      session.review.store.subscribe(attempt),
      session.mirror.subscribe(attempt),
      session.shared.subscribe(attempt),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [session, show]);

  // Navigation rewrites the current entry so the address names where the reader is.
  useEffect(
    () =>
      session.review.store.subscribe(() => {
        if (!resolvedInitial.current) return;
        writeAddress(currentAddress(), "replace");
      }),
    [currentAddress, session, writeAddress],
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
    const address = currentAddress();
    const { origin, pathname, hash } = window.location;
    try {
      await navigator.clipboard.writeText(
        reviewLinkWithCapability(
          { origin, pathname, hash: fragmentWithAddress(hash, address) },
          session.capability,
        ),
      );
      session.toasts.show(`Link copied. ${COPIED_LINK_GRANTS_ACCESS}`, "info");
    } catch {
      session.toasts.show("The browser did not allow copying the link.");
    }
  }, [currentAddress, session]);

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
                copied
                  ? `Review link copied. ${COPIED_LINK_GRANTS_ACCESS}`
                  : "The browser did not allow copying the link.",
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
        default:
          current.localHandlers?.[id]?.();
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
        // Keyed per tool: switching pickers starts a fresh query and active row.
        key="palette"
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
        key="goToFile"
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
