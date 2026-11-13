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
 *   expands it before the stream scrolls there.
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
  forgetViewedMark,
  rememberViewedMarks,
  reviewViewedStatus,
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

  // Every mark the session lists is remembered at its content, for "changed since viewed".
  useEffect(() => {
    if (!shared) return;
    setMemory((current) => rememberViewedMarks(current, shared.viewedFiles));
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

  // A hunk reveal into a collapsed viewed file opens it in the same render, so the stream
  // scrolls to the hunk rather than to a collapsed placeholder; the effect then keeps it open.
  // Selection changes from scrolling bump no token and open nothing.
  const hunkToken = review.reveal.hunkToken;
  const selectedKey = review.selection.fileKey;
  const [absorbedToken, setAbsorbedToken] = useState(hunkToken);
  const revealedKey = hunkToken !== absorbedToken ? selectedKey : null;
  useEffect(() => {
    if (hunkToken === absorbedToken) return;
    if (selectedKey && statuses.get(selectedKey) === "viewed") {
      setExpanded((current) =>
        current.has(selectedKey) ? current : new Set(current).add(selectedKey),
      );
    }
    setAbsorbedToken(hunkToken);
  }, [hunkToken, absorbedToken, selectedKey, statuses]);

  const collapsed = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, status] of statuses) {
      if (status === "viewed" && !expanded.has(key) && key !== revealedKey) keys.add(key);
    }
    return keys;
  }, [statuses, expanded, revealedKey]);

  const hidden = useMemo(() => {
    const keys = new Set<string>();
    if (!hideViewed) return keys;
    for (const [key, status] of statuses) if (status === "viewed") keys.add(key);
    return keys;
  }, [statuses, hideViewed]);
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
      // Marking collapses the file again; clearing forgets the content it was marked at.
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

  const toggleHideViewed = useCallback(() => {
    setHideViewed((current) => {
      writeStored(HIDE_VIEWED_KEY, current ? "off" : "on");
      return !current;
    });
  }, []);

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
  };
}

/** What the page's viewed workflow hands its components. */
export type ViewedFiles = ReturnType<typeof useViewedFiles>;
