/**
 * Observe portable trees in yielding batches while Chokidar normalizes file events and saves.
 * Separate depth-zero watchers expose a public ready boundary for each batch; adding paths to
 * an already-ready watcher does not. Depth zero bounds recursion, not a wide directory's own
 * readdir/stat work: that remaining flat-directory burst is the accepted batching floor.
 */
import { lstat, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";

export const PORTABLE_TREE_BATCH_SIZE = 32;

export interface PortableTreeRuntime {
  watch: typeof watch;
  readDirectories(directory: string): Promise<string[]>;
  /** Schedule one macrotask and return its cancellation function. */
  schedule(callback: () => void): () => void;
}

const defaultRuntime: PortableTreeRuntime = {
  watch,
  async readDirectories(directory) {
    // Explicit roots and directories replaced during admission can themselves be symlinks.
    // Match Chokidar's followSymlinks:false policy before enumerating their referents.
    if (!(await lstat(directory)).isDirectory()) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  },
  schedule(callback) {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  },
};

/** Register existing and newly created directories without recursively admitting a subtree. */
export function createChunkedTreeWatcher(
  directory: string,
  isIgnored: (path: string) => boolean,
  onEvent: () => void,
  runtimeOverrides: Partial<PortableTreeRuntime> = {},
) {
  const runtime = { ...defaultRuntime, ...runtimeOverrides };
  const root = resolve(directory);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const watchers = new Set<FSWatcher>();
  const retiring = new Set<Promise<void>>();
  const queued = new Set<string>();
  const known = new Set<string>();
  let anchor: FSWatcher | undefined;
  let closed = false;
  let ready = false;
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let cancelWork!: () => void;
  const cancelled = new Promise<void>((resolveCancelled) => {
    cancelWork = resolveCancelled;
  });
  let readyCallback: (() => void) | undefined;
  let errorCallback: ((error: unknown) => void) | undefined;
  let progressCallback: (() => void) | undefined;

  /** Deduplicate parent enumeration and repeated runtime addDir discovery. */
  function enqueue(path: string) {
    path = resolve(path);
    // Chokidar may observe a missing root's parent until the root is recreated. Never
    // turn that conservative fallback into recursive coverage outside this target.
    if (path !== root && !path.startsWith(rootPrefix)) return;
    if (closed || isIgnored(path) || known.has(path)) return;
    known.add(path);
    queued.add(path);
    schedule();
    if (ready) onEvent();
  }

  /** Yield between batches instead of chaining directory traversal through microtasks. */
  function schedule() {
    if (closed || draining || cancelTimer) return;
    cancelTimer = runtime.schedule(() => {
      cancelTimer = undefined;
      draining = drain()
        .catch(reportError)
        .finally(() => {
          draining = undefined;
          if (!closed && queued.size) schedule();
        });
    });
  }

  /** Forward errors without treating a partial or failed registration as scan completion. */
  function reportError(error: unknown) {
    if (!closed) errorCallback?.(error);
  }

  /** Complete one shallow scan, then enumerate its children for a later macrotask. */
  async function drain() {
    if (closed) return;
    const paths: string[] = [];
    for (const path of queued) {
      queued.delete(path);
      paths.push(path);
      if (paths.length === PORTABLE_TREE_BATCH_SIZE) break;
    }
    if (paths.length) {
      let watcher: FSWatcher;
      const roots = new Set(paths);
      try {
        watcher = runtime.watch(paths, {
          depth: 0,
          ignoreInitial: true,
          persistent: true,
          followSymlinks: false,
          usePolling: false,
          awaitWriteFinish: false,
          ignored(path, stats) {
            if (isIgnored(path)) return true;
            const normalized = resolve(path);
            if (
              stats?.isDirectory() &&
              normalized.startsWith(rootPrefix) &&
              !roots.has(normalized)
            ) {
              // Depth zero still stats each child twice unless it is pruned. Discover
              // non-root directories through the public filter and admit them in a later
              // batch instead; this also catches runtime creation without a raw-event hook.
              enqueue(normalized);
              return true;
            }
            return false;
          },
        });
      } catch (error) {
        // Without a registered batch there is no progress to report. The controller's
        // inactivity deadline (or resource-exhaustion error) closes this partial observer.
        queued.clear();
        reportError(error);
        return;
      }
      watchers.add(watcher);
      anchor ??= watcher;
      let markReady!: () => void;
      const batchReady = new Promise<void>((resolveReady) => {
        markReady = resolveReady;
      });
      watcher.once("ready", markReady);
      watcher.on("error", reportError);
      watcher.on("all", (event, path) => {
        if (closed) return;
        if (event === "addDir") enqueue(path);
        if (event === "unlinkDir") {
          known.delete(resolve(path));
          queued.delete(resolve(path));
          roots.delete(resolve(path));
          if (roots.size === 0) {
            // Keep the initial anchor: Chokidar may be watching a missing root's parent
            // there. Retire later empty batches so runtime churn does not retain instances.
            if (watcher !== anchor) {
              watchers.delete(watcher);
              const released = Promise.resolve()
                .then(() => watcher.close())
                .catch(reportError);
              retiring.add(released);
              void released.then(() => retiring.delete(released));
            }
            // Removal can race the initial scan. Enumeration reconciles missing paths;
            // do not await a ready event from a batch whose roots have all disappeared.
            markReady();
          }
        }
        onEvent();
      });
      await Promise.race([batchReady, cancelled]);
      watcher.off("ready", markReady);
      if (closed) return;
      if (!ready) progressCallback?.();
      await Promise.race([
        Promise.all(
          paths.map(async (path) => {
            try {
              const children = await runtime.readDirectories(path);
              for (const child of children) enqueue(child);
            } catch (error) {
              // A directory may disappear between Chokidar's scan and enumeration. Allow a
              // later addDir to rediscover it; report other filesystem failures the same way.
              known.delete(path);
              reportError(error);
            }
          }),
        ),
        cancelled,
      ]);
    }
    if (closed || queued.size) return;
    if (!ready) {
      ready = true;
      readyCallback?.();
    } else {
      // Population can race queued registration; reconcile even if its first event was early.
      onEvent();
    }
  }

  enqueue(directory);
  // A wholly ignored root still establishes an empty, ready registration.
  schedule();
  return {
    /** Cancel queued/in-flight work before closing every constructed handle exactly once. */
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      cancelTimer?.();
      cancelTimer = undefined;
      queued.clear();
      known.clear();
      cancelWork();
      closing = Promise.all([
        draining,
        ...retiring,
        ...[...watchers].map((watcher) => Promise.resolve().then(() => watcher.close())),
      ]).then(() => {
        watchers.clear();
      });
      return closing;
    },
    onError(callback: (error: unknown) => void) {
      errorCallback = callback;
    },
    onProgress(callback: () => void) {
      progressCallback = callback;
    },
    whenReady(callback: () => void) {
      readyCallback = callback;
      if (ready)
        queueMicrotask(() => {
          if (!closed) callback();
        });
    },
  };
}
