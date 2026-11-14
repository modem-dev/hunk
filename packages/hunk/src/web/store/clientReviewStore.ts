/**
 * Holds the page's own review state over the mirrored document.
 *
 * Selection is fully independent per surface by product decision: what this page selects,
 * reveals, and expands never moves the terminal, and the terminal's selection never moves
 * this page. So the page runs the shared `core/review` store locally — the same reducer,
 * planner, and selectors the terminal uses — and applies `selection/*` and
 * `expansion/toggle` intents to it with `applyReviewIntent`. None of them is ever posted.
 * Shared intents (notes, filter, note visibility) are not accepted here; they will be
 * forwarded to the producer once the page can author them.
 *
 * Shared state flows the other way: each shared-state snapshot the page accepts is adopted
 * with core actions — `filter/set`, `notes/set-visibility`, and the stored notes replaced
 * with exactly the snapshot's live and reviewer notes, keeping the producer's resolution —
 * so `selectVisibleThreadedStoredReviewNotes`, note ownership, and the navigation planner
 * answer for the page exactly as they do for the terminal. Sidecar annotations are not
 * stored notes in any surface's state; they reach annotated navigation through the
 * annotation index, which this store builds from every snapshot note with the shared
 * `buildReviewAnnotationIndexFromNotes` and hands the planner as its caller-owned fact.
 *
 * The document comes from the mirror. Every new document is adopted with the store's own
 * `document/reconcile` action, which retires expansion and loaded source for files whose
 * content changed and keeps everything else, so a reload keeps the reader's state by file
 * key. Gap source text is loaded on demand from the file's `source` resource and recorded
 * in the store's source-status vocabulary.
 */
import { buildReviewAnnotationIndexFromNotes } from "../../core/review/annotations";
import { applyReviewIntent, type ReviewIntent } from "../../core/review/intents";
import { selectNearestShownFileKey, selectNormalizedSelection } from "../../core/review/selectors";
import {
  EMPTY_REVIEW_ANNOTATION_INDEX,
  REVIEW_FILE_JUMP_HUNK_INDEX,
  type ReviewAnnotationIndex,
} from "../../core/review/navigation";
import type { ReviewStoredNote } from "../../core/review/state";
import { createReviewStore, type ReviewStore } from "../../core/review/store";
import type { ReviewDocumentV1 } from "../../core/review/types";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";
import { ReviewApiError, type ReviewApiClient } from "../transport/apiClient";

/** Intents this page applies to its own state and never sends anywhere. */
export const LOCAL_REVIEW_INTENT_TYPES = [
  "selection/select",
  "selection/move",
  "selection/select-file",
  "selection/anchor",
  "expansion/toggle",
] as const satisfies readonly ReviewIntent["type"][];

export type LocalReviewIntent = Extract<
  ReviewIntent,
  { type: (typeof LOCAL_REVIEW_INTENT_TYPES)[number] }
>;

/** Whether one intent is page-local. */
export function isLocalReviewIntent(intent: ReviewIntent): intent is LocalReviewIntent {
  return (LOCAL_REVIEW_INTENT_TYPES as readonly string[]).includes(intent.type);
}

export interface ClientReviewStoreOptions {
  client: ReviewApiClient;
}

/** The page's local review store and the source loads it drives. */
export class ClientReviewStore {
  readonly store: ReviewStore = createReviewStore({ files: [] });
  private catalog: HunkReviewResourceCatalogV1 | undefined;
  private shared: ReviewSharedStateV1 | undefined;
  private annotations: ReviewAnnotationIndex = EMPTY_REVIEW_ANNOTATION_INDEX;
  private hiddenFileKeys: ReadonlySet<string> = new Set();
  private readonly sourceLoads = new Map<string, AbortController>();

  constructor(private readonly options: ClientReviewStoreOptions) {}

  /**
   * Adopt one mirrored document and the catalog it came with.
   *
   * Keeps the selection when its file survives; otherwise moves it where the shared
   * `selectNormalizedSelection` says — the first visible file, or nothing — without asking the
   * viewport to move, which is what reconciliation means everywhere else (audit B4).
   */
  adopt(document: ReviewDocumentV1, catalog: HunkReviewResourceCatalogV1 | undefined) {
    if (catalog?.generation !== this.catalog?.generation) {
      // Source reads are addressed to a generation; one from the old catalog cannot land.
      for (const controller of this.sourceLoads.values()) controller.abort();
      this.sourceLoads.clear();
    }
    this.catalog = catalog;
    this.store.dispatch({ type: "document/reconcile", document });

    // An open gap whose read was aborted above, or whose unattested text reconciliation
    // dropped, loads again from the new catalog instead of waiting for a re-expansion.
    const reconciled = this.store.getSnapshot();
    const open = new Set(
      reconciled.expandedGaps.filter((gap) => gap.expanded).map((gap) => gap.fileKey),
    );
    for (const fileKey of open) {
      if (reconciled.sourceStatusByFileKey[fileKey]?.kind !== "error") {
        void this.loadSource(fileKey);
      }
    }

    const state = this.store.getSnapshot();
    const normalized = selectNormalizedSelection(state);
    if (
      normalized.fileKey !== null &&
      (normalized.fileKey !== state.selection.fileKey ||
        normalized.hunkIndex !== state.selection.hunkIndex)
    ) {
      this.store.dispatch({ type: "selection/select", ...normalized, fileKey: normalized.fileKey });
    }
  }

  /**
   * Adopt one shared-state snapshot: filter, note visibility, and the stored notes.
   *
   * Idempotent per snapshot. Stored notes are replaced wholesale rather than diffed, because
   * the snapshot is the whole truth about them at its revision.
   */
  adoptShared(state: ReviewSharedStateV1) {
    if (state === this.shared) return;
    this.shared = state;
    this.store.dispatch({ type: "filter/set", filter: state.filter });
    this.store.dispatch({ type: "notes/set-visibility", visible: state.showAgentNotes });
    const { activeNoteId, selection } = this.store.getSnapshot();
    this.store.dispatch({ type: "notes/clear", includeUser: true });
    const stored = (origin: "live" | "user"): ReviewStoredNote[] =>
      state.notes
        .filter((entry) => entry.origin === origin)
        .map((entry) => ({ note: entry.note, resolution: entry.resolution }));
    this.store.dispatch({ type: "notes/add-live", notes: stored("live") });
    for (const note of stored("user")) this.store.dispatch({ type: "notes/add-user", note });
    // Clearing drops the reader's active note; it comes back when the snapshot still has it.
    if (
      activeNoteId !== null &&
      selection.fileKey !== null &&
      state.notes.some((entry) => entry.note.id === activeNoteId)
    ) {
      this.store.dispatch({
        type: "selection/select",
        fileKey: selection.fileKey,
        hunkIndex: selection.hunkIndex,
        activeNoteId,
      });
    }
    this.annotations = buildReviewAnnotationIndexFromNotes(
      state.notes.map((entry) => entry.note),
      state.files.filter((file) => file.agentContext).map((file) => file.key),
    );
  }

  /** The annotation index the planner reads for annotated navigation. */
  annotationIndex() {
    return this.annotations;
  }

  /**
   * Name the files this page hides by the reader's choice ("hide viewed"); relative navigation
   * walks past them through the planner's `hiddenFileKeys` fact. The shared filter is separate.
   *
   * A selection whose file becomes hidden (the reader marks the selected file viewed, or turns
   * "Hide viewed" on) moves to the nearest shown file by `selectNearestShownFileKey`, without
   * asking the viewport to move, so navigation continues from where the reader was. With no
   * file shown it stays where it is; the page says that everything is hidden.
   */
  setHiddenFiles(fileKeys: ReadonlySet<string>) {
    this.hiddenFileKeys = fileKeys;

    const state = this.store.getSnapshot();
    const { fileKey } = selectNormalizedSelection(state);
    if (fileKey === null || !fileKeys.has(fileKey)) return;
    const nearest = selectNearestShownFileKey(state, fileKey, fileKeys);
    if (nearest !== null) {
      this.store.dispatch({
        type: "selection/select",
        fileKey: nearest,
        hunkIndex: REVIEW_FILE_JUMP_HUNK_INDEX,
      });
    }
  }

  /** Apply one page-local intent through the shared planner. */
  apply<T extends LocalReviewIntent>(intent: T) {
    if (!isLocalReviewIntent(intent)) {
      throw new Error(`Review intent ${(intent as ReviewIntent).type} is not page-local.`);
    }
    const outcome = applyReviewIntent(this.store, intent, {
      annotations: this.annotations,
      hiddenFileKeys: this.hiddenFileKeys,
    });
    if (intent.type === "expansion/toggle") {
      const toggled = outcome as { expanded: boolean };
      if (toggled.expanded) {
        void this.loadSource(intent.fileKey);
      }
    }
    return outcome;
  }

  /** Stop every source read in flight. */
  close() {
    for (const controller of this.sourceLoads.values()) controller.abort();
    this.sourceLoads.clear();
  }

  /**
   * Load one file's gap source once, recording its status in the shared vocabulary.
   *
   * Already-loaded and loading files are left alone; a failed load is retried by the next
   * expansion. A source over its kind's ceiling is reported as `too-large`, which the
   * renderer explains rather than retrying.
   */
  async loadSource(fileKey: string) {
    const state = this.store.getSnapshot();
    const status = state.sourceStatusByFileKey[fileKey];
    // `loading` with no read in flight is a read that was aborted, so it loads again.
    if (
      status?.kind === "loaded" ||
      (status?.kind === "loading" && this.sourceLoads.has(fileKey))
    ) {
      return;
    }
    const file = state.document.files.find((candidate) => candidate.key === fileKey);
    const descriptor = this.catalog?.resources.find(
      (resource) => resource.kind === "source" && resource.fileKey === fileKey,
    );
    if (!file || !descriptor) {
      this.store.dispatch({
        type: "expansion/set-source-status",
        fileKey,
        status: { kind: "error" },
      });
      return;
    }

    // A read still running for this file (its status was dropped by a reload of the same
    // generation) is superseded: aborted, and its answer ignored, so old text cannot land.
    this.sourceLoads.get(fileKey)?.abort();
    const controller = new AbortController();
    this.sourceLoads.set(fileKey, controller);
    this.store.dispatch({
      type: "expansion/set-source-status",
      fileKey,
      status: { kind: "loading" },
    });
    try {
      const bytes = await this.options.client.readResource(descriptor, controller.signal);
      if (controller.signal.aborted) return;
      this.store.dispatch({
        type: "expansion/set-source-status",
        fileKey,
        status: { kind: "loaded", text: new TextDecoder().decode(bytes) },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.store.dispatch({
        type: "expansion/set-source-status",
        fileKey,
        status:
          error instanceof ReviewApiError && error.code === "resource-too-large"
            ? { kind: "error", reason: "too-large" }
            : { kind: "error" },
      });
    } finally {
      if (this.sourceLoads.get(fileKey) === controller) this.sourceLoads.delete(fileKey);
    }
  }
}
