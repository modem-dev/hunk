import { createWatchController, type WatchController } from "../../core/watch/controller";
import { createWatchObserver, type WatchObserver } from "../../core/watch/observer";
import { assertReliableWatchRuntime } from "../../core/watch/runtime";
import type { ExtensionVcsStatusSnapshot } from "../../extension-api/types";
import type { StatusRuntime } from "./types";
import { reconcileStatusPathSelection, type StatusPathGroupId } from "./pathGroups";

/** Preserve surviving row order and append newly observed identities after them. */
function retainStatusOrder<T>(
  previous: readonly T[],
  next: readonly T[],
  identity: (row: T) => string,
) {
  const remaining = new Map(next.map((row) => [identity(row), row]));
  const retained = previous.flatMap((row) => {
    const replacement = remaining.get(identity(row));
    remaining.delete(identity(row));
    return replacement ? [replacement] : [];
  });
  return [...retained, ...remaining.values()];
}

export interface StatusState {
  snapshot: ExtensionVcsStatusSnapshot;
  selected: string | null;
  top: number;
  expandedWorktrees: boolean;
  expandedPathGroups: Record<StatusPathGroupId, boolean>;
  loading: boolean;
  siblingsLoading: boolean;
  notice: string;
  backPath?: string;
}

/** Retain navigation while edits, refresh and sibling inspection rebuild read-only status facts.
 * Suspend reads and watchers during routed log/review visits; the host owns those surfaces and
 * extension authority. Publish current facts before bounded sibling scans, never late generations.
 */
export class StatusController {
  private state: StatusState;
  private listeners = new Set<() => void>();
  private active = false;
  private closed = false;
  private closing?: Promise<void>;
  private generation = 0;
  private abort = new AbortController();
  private pending?: Promise<void>;
  private queued = false;
  private siblingGeneration = 0;
  private siblingAbort?: AbortController;
  private siblingTasks = new Set<Promise<void>>();
  private watch?: WatchController;
  private observer?: WatchObserver;
  private watcherClosing: Promise<void> = Promise.resolve();
  private watchTask?: Promise<void>;
  private retained: StatusState[] = [];

  constructor(
    readonly runtime: StatusRuntime,
    private readonly deps: {
      createObserver?: typeof createWatchObserver;
      createWatch?: typeof createWatchController;
    } = {},
  ) {
    this.state = {
      snapshot: runtime.snapshot,
      selected: runtime.snapshot.paths[0] ? `path:${runtime.snapshot.paths[0].path}` : null,
      top: 0,
      expandedWorktrees: false,
      expandedPathGroups: { tracked: false, untracked: false },
      loading: false,
      siblingsLoading: false,
      notice: runtime.notices.join(" · "),
    };
  }
  /** Return a stable observable snapshot. */
  getSnapshot = () => this.state;
  /** Subscribe the mounted status component. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(update: Partial<StatusState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  /** Keep provider errors visible without replacing usable prior facts. */
  setNotice(notice: string) {
    this.publish({ notice });
  }
  /** Retain focused row and viewport independently of provider ordering. */
  select(selected: string | null, top = this.state.top) {
    this.publish({ selected, top });
  }
  /** Expand the bounded worktree list in this same surface. */
  toggleWorktrees() {
    this.publish({ expandedWorktrees: !this.state.expandedWorktrees });
  }
  /** Toggle one local file group, moving hidden focus to its action instead of opening invisible files. */
  togglePathGroup(group: StatusPathGroupId) {
    const expandedPathGroups = {
      ...this.state.expandedPathGroups,
      [group]: !this.state.expandedPathGroups[group],
    };
    this.publish({
      expandedPathGroups,
      selected: reconcileStatusPathSelection(
        this.state.snapshot.paths,
        expandedPathGroups,
        this.state.selected,
      ),
    });
  }
  /** Resume observations after mount or return from a child surface. */
  resume() {
    if (this.closed || this.active) return;
    assertReliableWatchRuntime(Bun.version);
    this.active = true;
    this.abort = new AbortController();
    void this.refresh();
  }
  /** Stop observation synchronously and drain cancelled reads before changing targets. */
  async suspend() {
    this.active = false;
    this.generation++;
    this.abort.abort();
    this.cancelSiblings();
    this.queued = false;
    const watch = this.watch;
    watch?.close();
    this.watch = undefined;
    const observer = this.observer;
    this.observer = undefined;
    if (!watch) observer?.close();
    this.watcherClosing = Promise.all([this.watcherClosing, observer?.closed]).then(
      () => undefined,
    );
    await Promise.all([this.pending, this.watcherClosing, this.watchTask, ...this.siblingTasks]);
  }
  /** Invalidate secondary observations when suspending a target, retaining tasks until drained. */
  private cancelSiblings() {
    this.siblingGeneration++;
    this.siblingAbort?.abort();
    this.siblingAbort = undefined;
  }
  /** Refresh only sibling facts; late scans cannot replace a newer current observation. */
  private scanSiblings(snapshot: ExtensionVcsStatusSnapshot) {
    const generation = this.siblingGeneration;
    const abort = new AbortController();
    this.siblingAbort = abort;
    const signal = AbortSignal.any([abort.signal, this.abort.signal]);
    const current = () => this.active && !signal.aborted && generation === this.siblingGeneration;
    this.publish({ siblingsLoading: true });
    const task = (async () => {
      try {
        const full = await this.runtime.loadSiblings(snapshot, signal);
        if (!current()) return;
        if (full.siblings.state === "ready" && this.state.snapshot.siblings.state === "ready") {
          full.siblings.value.worktrees = retainStatusOrder(
            this.state.snapshot.siblings.value.worktrees,
            full.siblings.value.worktrees,
            (row) => row.worktree.id,
          );
        }
        this.publish({ snapshot: { ...this.state.snapshot, siblings: full.siblings } });
      } catch (error) {
        if (current())
          this.publish({
            snapshot: {
              ...this.state.snapshot,
              siblings: {
                state: "error",
                message: error instanceof Error ? error.message : String(error),
              },
            },
          });
      } finally {
        if (current()) {
          this.siblingAbort = undefined;
          this.publish({ siblingsLoading: false });
        }
      }
    })();
    this.siblingTasks.add(task);
    void task.finally(() => this.siblingTasks.delete(task));
  }
  /** Coalesce current reads independently of cancellable secondary sibling scans. */
  refresh = (): Promise<void> => {
    if (!this.active || this.closed) return Promise.resolve();
    if (this.pending) {
      this.queued = true;
      return this.pending;
    }
    const generation = this.generation;
    const signal = this.abort.signal;
    const current = () => this.active && !signal.aborted && generation === this.generation;
    this.pending = (async () => {
      do {
        this.queued = false;
        this.publish({ loading: true });
        try {
          const snapshot = await this.runtime.load(this.state.snapshot.worktree.path, signal);
          if (!current()) return;
          if (snapshot.worktree.repositoryId !== this.runtime.snapshot.worktree.repositoryId)
            throw new Error("Status repository identity changed.");
          // Preserve relative order of surviving paths so updates cannot sort under the cursor.
          snapshot.paths = retainStatusOrder(
            this.state.snapshot.paths,
            snapshot.paths,
            (path) => path.path,
          );
          if (this.state.snapshot.siblings.state === "ready")
            snapshot.siblings = this.state.snapshot.siblings;
          this.publish({
            snapshot,
            selected: reconcileStatusPathSelection(
              snapshot.paths,
              this.state.expandedPathGroups,
              this.state.selected,
            ),
            notice: this.state.notice.startsWith("Status stale:") ? "" : this.state.notice,
          });
          if (!this.watch && !this.watchTask) {
            this.watchTask = this.startWatch(snapshot, generation, signal).finally(() => {
              this.watchTask = undefined;
            });
          }
          // Same-target safety polls must let a bounded secondary scan finish, even when its
          // provider token or observation timestamp changes on every current read.
          if (!this.queued && !this.siblingAbort) this.scanSiblings(snapshot);
        } catch (error) {
          if (current())
            this.publish({
              notice: `Status stale: ${error instanceof Error ? error.message : String(error)}`,
            });
        } finally {
          if (current()) this.publish({ loading: false });
        }
      } while (this.queued && current());
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  };
  private async startWatch(
    snapshot: ExtensionVcsStatusSnapshot,
    generation: number,
    signal: AbortSignal,
  ) {
    try {
      const plan = await this.runtime.watchPlan(snapshot, signal);
      if (!this.active || signal.aborted || generation !== this.generation) return;
      let tick = 0;
      this.watch = (this.deps.createWatch ?? createWatchController)({
        initialSignature: "0",
        getSignature: () => String(++tick),
        refresh: this.refresh,
        pollOnly: plan.coverage === "poll-only",
        healthyCheckMs: 5000,
        createEventSource:
          plan.coverage === "poll-only"
            ? undefined
            : (callbacks) => {
                this.observer = (this.deps.createObserver ?? createWatchObserver)(plan, callbacks);
                return this.observer;
              },
        reportError: () => this.setNotice("Watching unavailable; polling status."),
      });
    } catch {
      if (!signal.aborted && this.active && generation === this.generation) {
        this.setNotice("Watching unavailable; polling status.");
        let tick = 0;
        this.watch = (this.deps.createWatch ?? createWatchController)({
          initialSignature: "0",
          getSignature: () => String(++tick),
          refresh: this.refresh,
          pollOnly: true,
        });
      }
    }
  }
  /** Inspect a validated sibling without changing launch cwd or extension ownership. */
  async inspect(path: string) {
    if (this.closed || !this.active) return;
    const previous = this.state;
    const suspending = this.suspend();
    const generation = this.generation;
    await suspending;
    if (this.closed || generation !== this.generation) return;
    this.abort = new AbortController();
    this.publish({ loading: true });
    this.pending = (async () => {
      try {
        const snapshot = await this.runtime.load(path, this.abort.signal);
        if (this.closed || generation !== this.generation || this.abort.signal.aborted) return;
        if (snapshot.worktree.repositoryId !== this.runtime.snapshot.worktree.repositoryId)
          throw new Error("Status repository identity changed.");
        this.retained.push(previous);
        this.publish({
          snapshot,
          selected: snapshot.paths[0] ? `path:${snapshot.paths[0].path}` : null,
          top: 0,
          backPath: previous.snapshot.worktree.path,
          notice: "",
        });
      } catch (error) {
        if (!this.abort.signal.aborted) this.setNotice(String(error));
      } finally {
        if (!this.closed && generation === this.generation) this.publish({ loading: false });
      }
    })();
    await this.pending;
    this.pending = undefined;
    if (!this.closed && generation === this.generation) this.resume();
  }
  /** Return to the retained originating target, then reconcile with fresh facts. */
  async back() {
    if (!this.retained.length || !this.active) return;
    const suspending = this.suspend();
    const generation = this.generation;
    await suspending;
    if (this.closed || generation !== this.generation) return;
    this.publish(this.retained.pop()!);
    this.resume();
  }
  /** Dispose timers, watcher handles and provider reads exactly once. */
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.suspend();
      await this.runtime.close();
    })();
    return this.closing;
  }
}
