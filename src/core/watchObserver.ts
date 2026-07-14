import { watch as nativeFsWatch } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { watch as chokidarWatch, type ChokidarOptions, type FSWatcher } from "chokidar";

import type { WatchEventSource, WatchEventSourceCallbacks } from "./watchController";
import type { DirectoryTreeWatchTarget, WatchPlan, WatchTarget } from "./watchPlan";

export interface WatchObserver extends WatchEventSource {
  ready: Promise<void>;
  closed: Promise<void>;
}

export interface WatchRegistration {
  close(): void | Promise<void>;
  onError(callback: (error: unknown) => void): void;
  whenReady(callback: () => void): void;
}

export type WatchTreeBackend = (
  target: DirectoryTreeWatchTarget,
  onEvent: () => void,
) => WatchRegistration;

export interface NativeRecursiveWatchHandle {
  close(): void;
  onError(callback: (error: unknown) => void): void;
}

export type NativeRecursiveWatchFactory = (
  directory: string,
  onChange: (filename: string | Buffer | null) => void,
) => NativeRecursiveWatchHandle;

export type WatchTreeBackendMode = "auto" | "native" | "chokidar";

export interface WatchObserverOptions {
  platform?: NodeJS.Platform;
  /** Test/benchmark-only injection; production callers retain platform-based auto selection. */
  treeBackend?: WatchTreeBackendMode;
  treeBackends?: {
    native: WatchTreeBackend;
    portable: WatchTreeBackend;
  };
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

/** Build an ancestor-set matcher whose cost depends on path depth, not ignored-root count. */
function createIgnoredRootMatcher(ignoredRoots: string[]) {
  const roots = new Set(ignoredRoots.map(normalizedPath));
  return (path: string) => {
    let current = normalizedPath(path);
    for (;;) {
      if (roots.has(current)) return true;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  };
}

/** Adapt one Chokidar handle to the observer's backend-neutral lifecycle. */
function chokidarRegistration(watcher: FSWatcher): WatchRegistration {
  return {
    close: () => watcher.close(),
    onError: (callback) => watcher.on("error", callback),
    whenReady: (callback) => watcher.once("ready", callback),
  };
}

/** Construct one Bun/Node native recursive handle behind a small test seam. */
const defaultNativeRecursiveWatch: NativeRecursiveWatchFactory = (directory, onChange) => {
  const watcher = nativeFsWatch(directory, { recursive: true }, (_event, filename) => {
    onChange(filename);
  });
  return {
    close: () => watcher.close(),
    onError: (callback) => watcher.on("error", callback),
  };
};

/** Return whether a native callback supplied enough path context for ignored-root filtering. */
function isTrustworthyNativeFilename(filename: string) {
  return filename.length > 0 && (isAbsolute(filename) || /[\\/]/.test(filename));
}

/** Observe one tree with Bun's bounded native recursion and in-process ignore filtering. */
export function createNativeTreeWatcher(
  target: DirectoryTreeWatchTarget,
  onEvent: () => void,
  watchNative: NativeRecursiveWatchFactory = defaultNativeRecursiveWatch,
): WatchRegistration {
  const isIgnored = createIgnoredRootMatcher(target.ignoredRoots);
  const watcher = watchNative(target.directory, (rawFilename) => {
    const filename = Buffer.isBuffer(rawFilename) ? rawFilename.toString() : rawFilename;
    if (!filename || !isTrustworthyNativeFilename(filename)) {
      onEvent();
      return;
    }

    if (!isIgnored(resolve(target.directory, filename))) onEvent();
  });

  return {
    close: () => watcher.close(),
    onError: (callback) => watcher.onError(callback),
    // Native registration has no scan-ready event; construction itself establishes the watch.
    whenReady: (callback) => queueMicrotask(callback),
  };
}

/** Observe one tree with Git-pruned Chokidar recursion on portable platforms. */
function createPortableTreeWatcher(
  target: DirectoryTreeWatchTarget,
  onEvent: () => void,
): WatchRegistration {
  const isIgnored = createIgnoredRootMatcher(target.ignoredRoots);
  const watcher = chokidarWatch(target.directory, {
    ...WATCH_OPTIONS,
    ignored: (path) => isIgnored(path),
  });
  watcher.on("all", onEvent);
  return chokidarRegistration(watcher);
}

const DEFAULT_TREE_BACKENDS = {
  native: createNativeTreeWatcher,
  portable: createPortableTreeWatcher,
} satisfies WatchObserverOptions["treeBackends"];

/** Create a depth-zero Chokidar watcher for one exact parent-directory target. */
function createDirectoryEntriesWatcher(
  target: Extract<WatchTarget, { kind: "directory-entries" }>,
  onEvent: () => void,
) {
  const entries = new Set(target.entries.map(normalizedPath));
  const options: ChokidarOptions = { ...WATCH_OPTIONS, depth: 0 };
  const watcher = chokidarWatch(target.directory, options);
  watcher.on("all", (_event, path) => {
    if (entries.has(normalizedPath(path))) onEvent();
  });
  return chokidarRegistration(watcher);
}

/** Select and construct the watcher for one neutral target. */
function watchTarget(
  target: WatchTarget,
  onEvent: () => void,
  platform: NodeJS.Platform,
  treeBackend: WatchTreeBackendMode,
  treeBackends: NonNullable<WatchObserverOptions["treeBackends"]>,
) {
  if (target.kind === "directory-entries") {
    return createDirectoryEntriesWatcher(target, onEvent);
  }

  const useNative =
    treeBackend === "native" ||
    (treeBackend === "auto" && (platform === "darwin" || platform === "win32"));
  return useNative ? treeBackends.native(target, onEvent) : treeBackends.portable(target, onEvent);
}

/** Close every constructed watcher, including handles whose close method throws. */
function closeRegistrations(registrations: WatchRegistration[]) {
  return Promise.all(
    registrations.map((registration) => Promise.resolve().then(() => registration.close())),
  );
}

/** Observe a hybrid watch plan and expose bounded lifecycle promises for callers. */
export function createWatchObserver(
  plan: WatchPlan,
  callbacks: WatchEventSourceCallbacks,
  options: WatchObserverOptions = {},
): WatchObserver {
  let isClosed = false;
  const registrations: WatchRegistration[] = [];
  let resolveReady!: () => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  let remainingReady = plan.targets.length;
  const platform = options.platform ?? process.platform;
  const treeBackend = options.treeBackend ?? "auto";
  const treeBackends = options.treeBackends ?? DEFAULT_TREE_BACKENDS;

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
      const registration = watchTarget(target, onEvent, platform, treeBackend, treeBackends);
      registrations.push(registration);
      registration.onError((error) => {
        if (!isClosed) callbacks.onError(error);
      });
      registration.whenReady(markReady);
    }
  } catch (error) {
    isClosed = true;
    resolveReady();
    void closeRegistrations(registrations).then(resolveClosed, resolveClosed);
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
      void closeRegistrations(registrations).then(resolveClosed, resolveClosed);
    },
  };
}

/** Adapt a hybrid plan to the controller's injected event-source factory. */
export function createWatchEventSource(plan: WatchPlan) {
  if (plan.coverage === "poll-only") return undefined;
  return (callbacks: WatchEventSourceCallbacks) => createWatchObserver(plan, callbacks);
}
