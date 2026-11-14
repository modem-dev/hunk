/**
 * Runs the page's viewed-files workflow: the "Viewed" checkboxes in file headers and sidebar
 * rows, the `V` chord and palette commands, the toolbar's progress and "Hide viewed" toggle,
 * and collapsing viewed files in the stream.
 *
 * Marking a file viewed is shared review state: it is sent as `files/set-viewed` through the
 * page's one action sender and comes back in the shared-state snapshot, which lists only marks
 * that still match each file's content. This hook owns what is page-local around it:
 *
 * - the per-browser memory of which content each file was marked at (`viewedFiles.ts`), so a
 *   file whose content changed since it was marked says so;
 * - "hide viewed", per browser, which removes viewed files from the stream and the sidebar and
 *   makes navigation walk past them (through the store's `hiddenFileKeys` fact);
 * - which viewed files the reader expanded. A viewed file's body is collapsed by default; a
 *   click expands it, and a hunk reveal into it (`]`, a note jump, an agent's navigation)
 *   expands it before the stream scrolls there;
 * - the one hidden file an explicit jump revealed. Relative navigation never lands on a hidden
 *   file, so any reveal request that does (a deep link, go to file, an Overview row, a Notes
 *   tab row, an agent's navigation) is one the reader or the agent asked for by name: that file
 *   is shown, expanded, despite "Hide viewed" until the next explicit jump lands elsewhere or
 *   the reader toggles "Hide viewed". A request to look somewhere is never silently dropped.
 *
 * The session decides the marks; nothing here sends anything but `files/set-viewed`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { countReviewViewedFiles } from "../../core/review/overview";
import type { ReviewState } from "../../core/review/state";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";
import type { ReviewActionSender } from "../actions/reviewActions";
import type { ClientReviewStore } from "../store/clientReviewStore";
import {
  forgetClearedViewedMarks,
  forgetViewedMark,
  rememberViewedMarks,
  reviewViewedStatus,
  reviewViewedVisibility,
  type ReviewViewedStatus,
  type ViewedMemory,
} from "./viewedFiles";

const HIDE_VIEWED_KEY = "hunk.review.hideViewed";
const MEMORY_KEY_PREFIX = "hunk.review.viewed.";

/** Read one stored value, tolerating storage that is missing or refuses access. */
function readStored(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store one value, tolerating storage that is missing or refuses access. */
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Per-browser conveniences only; the page works without them.
  }
}

/** Read this session's viewed memory, or an empty one. */
function readMemory(sessionId: string): ViewedMemory {
  try {
    const parsed = JSON.parse(readStored(MEMORY_KEY_PREFIX + sessionId) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export interface UseViewedFilesOptions {
  sessionId: string;
  /** The shared snapshot for the generation shown, when it has arrived. */
  shared: ReviewSharedStateV1 | undefined;
  /** The files the shared filter leaves visible, in review order. */
  files: readonly { key: string }[];
  review: Pick<ReviewState, "selection" | "reveal">;
  store: Pick<ClientReviewStore, "setHiddenFiles">;
  actions: Pick<ReviewActionSender, "send">;
  /** Show one failure in the page's toast region. */
  showError: (message: string) => void;
}

/** The page's viewed-file state and gestures. */
export function useViewedFiles(options: UseViewedFilesOptions) {
  const { sessionId, shared, files, review, store, actions, showError } = options;
  const [memory, setMemory] = useState<ViewedMemory>(() => readMemory(sessionId));
  const [hideViewed, setHideViewed] = useState(() => readStored(HIDE_VIEWED_KEY) === "on");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Every mark the session lists is remembered at its content, for "changed since viewed";
  // a mark it stopped listing while the content stayed the same was cleared, and is forgotten.
  useEffect(() => {
    if (!shared) return;
    setMemory((current) =>
      forgetClearedViewedMarks(
        rememberViewedMarks(current, shared.viewedFiles),
        shared.files,
        shared.viewedFiles,
      ),
    );
  }, [shared]);
  useEffect(() => {
    writeStored(MEMORY_KEY_PREFIX + sessionId, JSON.stringify(memory));
  }, [memory, sessionId]);

  const statuses = useMemo(() => {
    const byKey = new Map<string, ReviewViewedStatus>();
    if (!shared) return byKey;
    for (const file of shared.files) {
      byKey.set(file.key, reviewViewedStatus(file, shared.viewedFiles, memory));
    }
    return byKey;
  }, [shared, memory]);

  const progress = useMemo(
    () => ({
      viewed: shared ? countReviewViewedFiles(files, shared.viewedFiles) : 0,
      total: files.length,
    }),
    [files, shared],
  );

  // A reveal request (either token) not yet absorbed is a navigation landing on the selected
  // file. Its effects apply in the same render, so the stream scrolls to the file as it will
  // be drawn; the effect below then records them. Selection changes from scrolling bump no
  // token and change nothing here.
  const { hunkToken, fileTopToken } = review.reveal;
  const selectedKey = review.selection.fileKey;
  const [absorbed, setAbsorbed] = useState({ hunkToken, fileTopToken });
  const [revealed, setRevealed] = useState<string | null>(null);
  const landing =
    hunkToken !== absorbed.hunkToken || fileTopToken !== absorbed.fileTopToken ? selectedKey : null;
  const landingViewed = landing !== null && statuses.get(landing) === "viewed";
  // A hunk reveal opens a collapsed viewed file; any reveal onto a hidden one reveals it.
  const opening = landingViewed && hunkToken !== absorbed.hunkToken ? landing : null;
  const shownDespiteHide = landingViewed && hideViewed ? landing : landing ? null : revealed;
  useEffect(() => {
    if (hunkToken === absorbed.hunkToken && fileTopToken === absorbed.fileTopToken) return;
    if (opening) {
      setExpanded((current) => (current.has(opening) ? current : new Set(current).add(opening)));
    }
    setRevealed(shownDespiteHide);
    setAbsorbed({ hunkToken, fileTopToken });
  }, [hunkToken, fileTopToken, absorbed, opening, shownDespiteHide]);

  const { hidden, collapsed } = useMemo(
    () =>
      reviewViewedVisibility(statuses, {
        hideViewed,
        expanded,
        opening,
        revealed: shownDespiteHide,
      }),
    [statuses, hideViewed, expanded, opening, shownDespiteHide],
  );
  useEffect(() => {
    store.setHiddenFiles(hidden);
  }, [store, hidden]);

  /** Mark or clear one file's viewed mark for every surface. */
  const setViewed = useCallback(
    async (fileKey: string, viewed: boolean) => {
      const outcome = await actions.send({ type: "files/set-viewed", fileKey, viewed });
      if (!outcome.ok) {
        showError(outcome.message);
        return;
      }
      // Marking collapses the file again, and hides it again if a jump had revealed it;
      // clearing forgets the content it was marked at.
      if (viewed) setRevealed((current) => (current === fileKey ? null : current));
      setExpanded((current) => {
        if (!current.has(fileKey)) return current;
        const next = new Set(current);
        next.delete(fileKey);
        return next;
      });
      if (!viewed) setMemory((current) => forgetViewedMark(current, fileKey));
    },
    [actions, showError],
  );

  /** Flip one file's mark: a viewed file is cleared, any other file is marked. */
  const toggleViewed = useCallback(
    (fileKey: string) => void setViewed(fileKey, statuses.get(fileKey) !== "viewed"),
    [setViewed, statuses],
  );

  const expand = useCallback((fileKey: string) => {
    setExpanded((current) => new Set(current).add(fileKey));
  }, []);

  const collapse = useCallback((fileKey: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(fileKey);
      return next;
    });
  }, []);

  // Toggling either way ends a jump's reveal: the setting then means what it says.
  const toggleHideViewed = useCallback(() => {
    setRevealed(null);
    setHideViewed((current) => {
      writeStored(HIDE_VIEWED_KEY, current ? "off" : "on");
      return !current;
    });
  }, []);

  /**
   * Open a collapsed viewed file that hunk navigation (`]`, `[`, annotated hunks) just entered.
   *
   * Crossing into the next file reveals its top rather than the hunk, which carries no hunk
   * reveal for the workflow above to see, so the page's hunk commands call this instead. File
   * navigation (`,` `.`, the sidebar) lands on the collapsed row and leaves it collapsed.
   */
  const openForHunk = useCallback(
    (fileKey: string) => {
      if (statuses.get(fileKey) !== "viewed") return;
      setExpanded((current) => (current.has(fileKey) ? current : new Set(current).add(fileKey)));
    },
    [statuses],
  );

  return {
    statuses,
    progress,
    collapsed,
    hidden,
    hideViewed,
    toggleViewed,
    expand,
    collapse,
    toggleHideViewed,
    openForHunk,
  };
}

/** What the page's viewed workflow hands its components. */
export type ViewedFiles = ReturnType<typeof useViewedFiles>;
