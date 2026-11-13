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
 * The document comes from the mirror. Every new document is adopted with the store's own
 * `document/reconcile` action, which retires expansion and loaded source for files whose
 * content changed and keeps everything else, so a reload keeps the reader's state by file
 * key. Gap source text is loaded on demand from the file's `source` resource and recorded
 * in the store's source-status vocabulary.
 */
import { applyReviewIntent, type ReviewIntent } from "../../core/review/intents";
import { createReviewStore, type ReviewStore } from "../../core/review/store";
import type { ReviewDocumentV1 } from "../../core/review/types";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
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
  private readonly sourceLoads = new Map<string, AbortController>();

  constructor(private readonly options: ClientReviewStoreOptions) {}

  /**
   * Adopt one mirrored document and the catalog it came with.
   *
   * Keeps the selection when its file survives; otherwise selects the first file without
   * asking the viewport to move, which is what reconciliation means everywhere else.
   */
  adopt(document: ReviewDocumentV1, catalog: HunkReviewResourceCatalogV1 | undefined) {
    if (catalog?.generation !== this.catalog?.generation) {
      // Source reads are addressed to a generation; one from the old catalog cannot land.
      for (const controller of this.sourceLoads.values()) controller.abort();
      this.sourceLoads.clear();
    }
    this.catalog = catalog;
    this.store.dispatch({ type: "document/reconcile", document });

    const { selection } = this.store.getSnapshot();
    const selected = document.files.find((file) => file.key === selection.fileKey);
    const first = document.files[0];
    if (!selected && first) {
      this.store.dispatch({ type: "selection/select", fileKey: first.key, hunkIndex: 0 });
    }
  }

  /** Apply one page-local intent through the shared planner. */
  apply<T extends LocalReviewIntent>(intent: T) {
    if (!isLocalReviewIntent(intent)) {
      throw new Error(`Review intent ${(intent as ReviewIntent).type} is not page-local.`);
    }
    const outcome = applyReviewIntent(this.store, intent);
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
    if (status?.kind === "loaded" || status?.kind === "loading") {
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
