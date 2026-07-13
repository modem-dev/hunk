import { resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";

import type { WatchEventSource, WatchEventSourceCallbacks } from "./watchController";
import type { WatchPlan, WatchTarget } from "./watchPlan";

export interface WatchObserver extends WatchEventSource {
  ready: Promise<void>;
  closed: Promise<void>;
}

const WATCH_OPTIONS = {
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  usePolling: false,
  awaitWriteFinish: false,
} as const;

/** Normalize an absolute runtime path for exact event and ignored-root comparisons. */
function normalizedPath(path: string) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Return whether a path is one ignored root or one of its descendants. */
function isWithinRoot(path: string, root: string) {
  if (path === root) return true;
  const separator = process.platform === "win32" ? "\\" : "/";
  return path.startsWith(`${root}${separator}`);
}

/** Create the Chokidar watcher for one neutral target and its event filter. */
function watchTarget(target: WatchTarget, onEvent: () => void) {
  if (target.kind === "directory-entries") {
    const entries = new Set(target.entries.map(normalizedPath));
    const watcher = watch(target.directory, { ...WATCH_OPTIONS, depth: 0 });
    watcher.on("all", (_event, path) => {
      if (entries.has(normalizedPath(path))) onEvent();
    });
    return watcher;
  }

  const ignoredRoots = target.ignoredRoots.map(normalizedPath);
  const watcher = watch(target.directory, {
    ...WATCH_OPTIONS,
    ignored: (path) => {
      const normalized = normalizedPath(path);
      return ignoredRoots.some((root) => isWithinRoot(normalized, root));
    },
  });
  watcher.on("all", () => onEvent());
  return watcher;
}

/** Observe a hybrid watch plan with Chokidar and expose bounded lifecycle promises for callers. */
export function createWatchObserver(
  plan: WatchPlan,
  callbacks: WatchEventSourceCallbacks,
): WatchObserver {
  let isClosed = false;
  const watchers: FSWatcher[] = [];
  let resolveReady!: () => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  let remainingReady = plan.targets.length;

  const onEvent = () => {
    if (!isClosed) callbacks.onEvent();
  };
  const markReady = () => {
    if (isClosed) return;
    remainingReady--;
    if (remainingReady === 0) {
      resolveReady();
      callbacks.onReady?.();
    }
  };

  try {
    for (const target of plan.targets) {
      const watcher = watchTarget(target, onEvent);
      watchers.push(watcher);
      watcher.once("ready", markReady);
      watcher.on("error", (error) => {
        if (!isClosed) callbacks.onError(error);
      });
    }
  } catch (error) {
    isClosed = true;
    resolveReady();
    void Promise.all(watchers.map((watcher) => watcher.close())).then(resolveClosed, resolveClosed);
    throw error;
  }

  if (remainingReady === 0) {
    queueMicrotask(() => {
      if (isClosed) return;
      resolveReady();
      callbacks.onReady?.();
    });
  }

  return {
    ready,
    closed,
    /** Mark closed immediately, then release every watcher handle exactly once. */
    close() {
      if (isClosed) return;
      isClosed = true;
      resolveReady();
      void Promise.all(watchers.map((watcher) => watcher.close())).then(
        resolveClosed,
        resolveClosed,
      );
    },
  };
}

/** Adapt a hybrid plan to the controller's injected event-source factory. */
export function createWatchEventSource(plan: WatchPlan) {
  if (plan.coverage === "poll-only") return undefined;
  return (callbacks: WatchEventSourceCallbacks) => createWatchObserver(plan, callbacks);
}
