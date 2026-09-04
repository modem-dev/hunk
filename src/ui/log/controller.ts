import { createHistoryLaneCheckpoint, planHistoryPage } from "../../core/history/lanePlanner";
import type { HistoryGraphRow, HistoryLaneCheckpoint } from "../../core/history/types";
import type { ExtensionVcsHistoryReviewAction } from "../../extension-api/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import type { HistoryRuntime } from "../history/types";

export interface LogPresentation {
  format: "compact" | "medium";
  graph: boolean;
  unicode: boolean;
  author: boolean;
  date: boolean;
  decorations: boolean;
}

export interface LogSnapshot {
  rows: readonly HistoryGraphRow[];
  selected: number;
  top: number;
  search: string;
  searchEditing: boolean;
  historyDone: boolean;
  loading: boolean;
  notice: string;
  themeId?: string;
  presentation: LogPresentation;
}

/** Retain interactive log state independently of renderer mount/unmount cycles. */
export class LogController {
  private source: HistoryRuntime["source"];
  private checkpoint: HistoryLaneCheckpoint = createHistoryLaneCheckpoint();
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private loadingPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private navigationTarget: number | null = null;
  private closed = false;
  private viewportHeight = 1;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: LogSnapshot;

  constructor(private readonly runtime: HistoryRuntime) {
    this.source = runtime.source;
    this.snapshot = {
      rows: [],
      selected: 0,
      top: 0,
      search: "",
      searchEditing: false,
      historyDone: false,
      loading: false,
      notice: runtime.notices[0] ?? "",
      themeId: runtime.input.theme,
      presentation: {
        format: runtime.input.format,
        graph: true,
        unicode: !runtime.input.ascii && process.env.TERM !== "dumb",
        author: true,
        date: true,
        decorations: true,
      },
    };
  }

  /** Return the immutable render snapshot. */
  getSnapshot = () => this.snapshot;

  /** Subscribe one mounted surface to controller changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<LogSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Load one bounded page, preserving symbolic graph state across page boundaries. */
  async loadMore() {
    if (this.loadingPromise) return this.loadingPromise;
    if (this.closed || this.snapshot.historyDone) return;
    const generation = this.generation;
    this.publish({ loading: true });
    const loading = (async () => {
      try {
        const page = await this.source.read({ limit: 256, signal: this.abort.signal });
        if (generation !== this.generation || this.closed) return;
        if (!page.done && page.commits.length === 0)
          throw new Error("VCS history returned an empty page before EOF.");
        const planned = planHistoryPage(page.commits, this.checkpoint);
        this.checkpoint = planned.checkpoint;
        const rows = [...this.snapshot.rows, ...planned.rows];
        this.publish({
          rows,
          historyDone: page.done,
          notice: rows.length === 0 && page.done ? "No commits found." : this.snapshot.notice,
        });
      } catch (error) {
        if (!this.abort.signal.aborted && generation === this.generation) {
          this.publish({
            historyDone: true,
            notice: sanitizeTerminalLine(error instanceof Error ? error.message : String(error)),
          });
        }
      } finally {
        if (generation === this.generation && !this.closed) this.publish({ loading: false });
      }
    })();
    this.loadingPromise = loading;
    try {
      await loading;
    } finally {
      if (this.loadingPromise === loading) this.loadingPromise = null;
    }
  }

  /** Keep the selected row visible in a viewport of fixed-height compact rows. */
  clampViewport(height: number) {
    const safeHeight = Math.max(1, height);
    this.viewportHeight = safeHeight;
    const selected = Math.max(
      0,
      Math.min(Math.max(0, this.snapshot.rows.length - 1), this.snapshot.selected),
    );
    let top = this.snapshot.top;
    if (selected < top) top = selected;
    if (selected >= top + safeHeight) top = selected - safeHeight + 1;
    top = Math.max(0, Math.min(top, Math.max(0, this.snapshot.rows.length - safeHeight)));
    if (selected !== this.snapshot.selected || top !== this.snapshot.top)
      this.publish({ selected, top });
  }

  /** Select a target, loading bounded continuation pages until it exists or EOF is known. */
  async select(index: number, viewportHeight: number) {
    this.clearNotice();
    const target = Math.max(0, index);
    this.navigationTarget = target;
    while (target >= this.snapshot.rows.length && !this.snapshot.historyDone && !this.closed) {
      await this.loadMore();
    }
    if (this.closed) return;
    this.publish({ selected: Math.max(0, Math.min(this.snapshot.rows.length - 1, target)) });
    this.clampViewport(viewportHeight);
    if (this.navigationTarget === target) this.navigationTarget = null;
    if (target + viewportHeight >= this.snapshot.rows.length && !this.snapshot.historyDone)
      void this.loadMore();
  }

  move(delta: number, viewportHeight: number) {
    return this.select((this.navigationTarget ?? this.snapshot.selected) + delta, viewportHeight);
  }

  page(delta: number, viewportHeight: number) {
    return this.move(delta * Math.max(1, viewportHeight), viewportHeight);
  }

  first(viewportHeight: number) {
    return this.select(0, viewportHeight);
  }

  async last(viewportHeight: number) {
    while (!this.snapshot.historyDone && !this.closed) await this.loadMore();
    await this.select(this.snapshot.rows.length - 1, viewportHeight);
  }

  /** Enter or update the focused search editor without filtering topology. */
  setSearch(search: string, editing = this.snapshot.searchEditing) {
    this.publish({ search, searchEditing: editing });
  }

  appendSearch(text: string) {
    this.publish({ search: this.snapshot.search + text });
  }

  backspaceSearch() {
    this.publish({ search: Array.from(this.snapshot.search).slice(0, -1).join("") });
  }

  beginSearch() {
    this.clearNotice();
    this.publish({ searchEditing: true });
  }

  cancelSearch() {
    this.publish({ searchEditing: false });
  }

  async finishSearch(direction: 1 | -1 = 1, viewportHeight = this.viewportHeight) {
    this.publish({ searchEditing: false });
    await this.findMatch(direction, viewportHeight);
  }

  async findMatch(direction: 1 | -1, viewportHeight = this.viewportHeight) {
    const needle = this.snapshot.search.toLocaleLowerCase();
    if (!needle) return;
    while (!this.snapshot.historyDone && !this.closed) await this.loadMore();
    const rows = this.snapshot.rows;
    for (let step = 1; step <= rows.length; step += 1) {
      const index = (this.snapshot.selected + direction * step + rows.length) % rows.length;
      const commit = rows[index]!.commit;
      const haystack = [
        commit.revisionId,
        commit.displayId,
        commit.subject,
        commit.body ?? "",
        commit.authorName,
        commit.authorEmail ?? "",
        ...commit.decorations.map((entry) => entry.label),
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (haystack.includes(needle)) {
        this.publish({ selected: index, notice: "" });
        this.clampViewport(viewportHeight);
        return;
      }
    }
    this.setNotice(`No match for ${this.snapshot.search}`);
  }

  private clearNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (this.snapshot.notice) this.publish({ notice: "" });
  }

  setNotice(notice: string) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const safe = sanitizeTerminalLine(notice);
    this.publish({ notice: safe });
    if (safe) {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = null;
        if (!this.closed && this.snapshot.notice === safe) this.publish({ notice: "" });
      }, 2500);
      this.noticeTimer.unref?.();
    }
  }

  setTheme(themeId: string) {
    this.publish({ themeId });
  }

  togglePresentation(key: keyof Omit<LogPresentation, "format">) {
    this.publish({
      presentation: { ...this.snapshot.presentation, [key]: !this.snapshot.presentation[key] },
    });
  }

  setFormat(format: LogPresentation["format"]) {
    this.publish({ presentation: { ...this.snapshot.presentation, format } });
  }

  /** Refresh the provider cursor while reconciling selection by immutable revision id. */
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshing = this.performRefresh();
    this.refreshPromise = refreshing;
    try {
      await refreshing;
    } finally {
      if (this.refreshPromise === refreshing) this.refreshPromise = null;
    }
  }

  private async performRefresh() {
    if (this.closed) return;
    const selectedId = this.snapshot.rows[this.snapshot.selected]?.commit.revisionId;
    const viewportOffset = this.snapshot.selected - this.snapshot.top;
    this.generation += 1;
    const generation = this.generation;
    this.abort.abort();
    await this.loadingPromise;
    this.loadingPromise = null;
    this.abort = new AbortController();
    let replacement: HistoryRuntime["source"];
    try {
      replacement = await this.runtime.reopenSource(this.abort.signal);
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (this.closed || generation !== this.generation) {
      await replacement.close();
      return;
    }
    this.source = replacement;
    this.checkpoint = createHistoryLaneCheckpoint();
    this.publish({
      rows: [],
      selected: 0,
      top: 0,
      historyDone: false,
      loading: false,
      notice: "",
    });
    await this.loadMore();
    if (selectedId) {
      while (
        !this.snapshot.historyDone &&
        !this.snapshot.rows.some((row) => row.commit.revisionId === selectedId)
      ) {
        await this.loadMore();
      }
      const index = this.snapshot.rows.findIndex((row) => row.commit.revisionId === selectedId);
      if (index >= 0) {
        const maxTop = Math.max(0, this.snapshot.rows.length - this.viewportHeight);
        this.publish({
          selected: index,
          top: Math.min(maxTop, Math.max(0, index - viewportOffset)),
        });
      }
    }
    this.setNotice("History refreshed.");
  }

  /** Ask the selected provider to describe the review without interpreting revision syntax. */
  getSelectedRow() {
    return this.snapshot.rows[this.snapshot.selected];
  }

  planSelectedReview(parentRevisionId?: string): Promise<ExtensionVcsHistoryReviewAction> | null {
    const commit = this.getSelectedRow()?.commit;
    return commit
      ? this.runtime.planReview(
          commit,
          parentRevisionId === undefined ? undefined : { parentRevisionId },
        )
      : null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.abort.abort();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    await this.runtime.close();
  }
}
