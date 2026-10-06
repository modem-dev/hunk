import type {
  DirectoryReadResult,
  DocumentEntry,
  DocumentReadResult,
  DocumentSource,
} from "../../core/documents/source";

export interface DocumentTreeRow {
  entry: DocumentEntry;
  depth: number;
}

export interface DocumentBrowserSnapshot {
  rows: readonly DocumentTreeRow[];
  selectedKey: string | null;
  documentKey: string | null;
  documentEntry: DocumentEntry | null;
  document: DocumentReadResult | null;
  expanded: ReadonlySet<string>;
  showExcluded: boolean;
  loading: boolean;
  notice: string | null;
}

/** Flatten only expanded, already loaded directories; unloaded descendants never enter the tree. */
export function documentTreeRows(
  root: DocumentEntry,
  directories: ReadonlyMap<string, DirectoryReadResult>,
  expanded: ReadonlySet<string>,
  showExcluded: boolean,
): DocumentTreeRow[] {
  const rows: DocumentTreeRow[] = [];
  const visit = (entry: DocumentEntry, depth: number) => {
    rows.push({ entry, depth });
    if (!expanded.has(entry.key)) return;
    const listing = directories.get(entry.key);
    if (listing?.kind !== "entries") return;

    for (const child of listing.entries) {
      if (!showExcluded && (child.hidden || child.ignored)) continue;
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return rows;
}

/** Own lazy expansion, document selection and serialized refreshes independently of React or reviews. */
export class DocumentBrowserController {
  private directories = new Map<string, DirectoryReadResult>();
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private readGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshPending = false;
  private closed = false;
  private stopObservation?: () => void;
  private listingRequests = new Map<string, Promise<void>>();
  private pendingReads = new Set<Promise<DocumentReadResult>>();
  private readController?: AbortController;
  private closePromise?: Promise<void>;
  private snapshot: DocumentBrowserSnapshot;

  constructor(readonly source: DocumentSource) {
    this.snapshot = {
      rows: [{ entry: source.root, depth: 0 }],
      selectedKey: source.root.key,
      documentKey: null,
      documentEntry: null,
      document: null,
      expanded: new Set(),
      showExcluded: false,
      loading: false,
      notice: null,
    };
  }

  /** Report whether this surface has revoked all source demand. */
  get isClosed() {
    return this.closed;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Load only the root directory or explicitly opened document. */
  async initialize() {
    if (this.source.root.kind === "directory") await this.activate(this.source.root.key);
    else await this.select(this.source.root.key);
    this.observe();
  }

  /** Replace a snapshot atomically; subscribers never observe partially updated tree geometry. */
  private publish(change: Partial<DocumentBrowserSnapshot>) {
    if (this.closed) return;

    const next = { ...this.snapshot, ...change };
    next.rows = documentTreeRows(
      this.source.root,
      this.directories,
      next.expanded,
      next.showExcluded,
    );
    if (!next.rows.some((row) => row.entry.key === next.selectedKey))
      next.selectedKey = next.rows[0]?.entry.key ?? null;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Load one directory once, sharing concurrent requests for the same key. */
  private loadDirectory(key: string): Promise<void> {
    const existing = this.listingRequests.get(key);
    if (existing) return existing;

    const request = (async () => {
      const result = await this.source.list(key, this.controller.signal);
      if (this.closed || !this.snapshot.expanded.has(key)) return;
      this.directories.set(key, result);
      this.publish({ notice: result.kind === "unavailable" ? result.detail : null });
    })()
      .catch((error) => {
        if (!this.closed) this.publish({ notice: String(error) });
      })
      .finally(() => {
        if (this.listingRequests.get(key) === request) this.listingRequests.delete(key);
      });
    this.listingRequests.set(key, request);
    return request;
  }

  /** Cancel obsolete document demand and retain in-flight reads until shutdown settles them. */
  private readDocument(key: string): Promise<DocumentReadResult> {
    this.readController?.abort();
    this.readController = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, this.readController.signal]);
    const request = this.source.read(key, signal).finally(() => this.pendingReads.delete(request));
    this.pendingReads.add(request);
    return request;
  }

  /** Select a tree row; stale file reads cannot overwrite a later selection. */
  async select(key: string) {
    const entry = this.snapshot.rows.find((row) => row.entry.key === key)?.entry;
    if (!entry || this.closed) return;

    this.publish({ selectedKey: key });
    if (entry.kind === "directory") return;

    const generation = ++this.readGeneration;
    this.publish({ documentKey: key, documentEntry: entry, document: null, loading: true });
    this.observe();

    try {
      const document = await this.readDocument(key);
      if (generation === this.readGeneration) this.publish({ document, loading: false });
    } catch (error) {
      if (!this.closed && generation === this.readGeneration)
        this.publish({
          loading: false,
          document: {
            kind: "unavailable",
            reason: "unreadable",
            detail: "Cannot read this document.",
          },
          notice: String(error),
        });
    }
  }

  /** Toggle one directory or open a document, through the same path for mouse and keyboard. */
  async activate(key: string) {
    const entry = this.snapshot.rows.find((row) => row.entry.key === key)?.entry;
    if (!entry || this.closed) return;
    if (entry.kind !== "directory") return this.select(key);

    const expanded = new Set(this.snapshot.expanded);
    if (expanded.has(key)) {
      expanded.delete(key);
      this.directories.delete(key);
      const index = this.snapshot.rows.findIndex((row) => row.entry.key === key);
      const depth = this.snapshot.rows[index]!.depth;
      for (const row of this.snapshot.rows.slice(index + 1)) {
        if (row.depth <= depth) break;
        expanded.delete(row.entry.key);
        this.directories.delete(row.entry.key);
      }
    } else {
      if (expanded.size >= 128) {
        this.publish({ notice: "Close a directory before expanding more than 128 directories." });
        return;
      }
      expanded.add(key);
    }

    this.publish({ selectedKey: key, expanded });
    this.observe();
    if (expanded.has(key) && !this.directories.has(key)) await this.loadDirectory(key);
    this.observe();
  }

  /** Move within the visible tree without deriving navigation from filesystem indexes. */
  move(delta: number) {
    const rows = this.snapshot.rows;
    const current = rows.findIndex((row) => row.entry.key === this.snapshot.selectedKey);
    const row = rows[Math.max(0, Math.min(rows.length - 1, current + delta))];
    if (row) void this.select(row.entry.key);
  }

  /** Reveal hidden and ignored entries without changing filesystem reads or following symlinks. */
  toggleExcluded() {
    this.publish({ showExcluded: !this.snapshot.showExcluded });
  }

  /** Rebuild demanded listings and the selected document, coalescing watch and manual triggers. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.refreshPending = true;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      while (this.refreshPending && !this.closed) {
        this.refreshPending = false;
        for (const key of this.snapshot.expanded) {
          // A notification during initial expansion must schedule a fresh listing after that read.
          await this.listingRequests.get(key);
          if (!this.closed && this.snapshot.expanded.has(key)) await this.loadDirectory(key);
        }

        const key = this.snapshot.documentKey;
        if (key) {
          const generation = ++this.readGeneration;
          const document = await this.readDocument(key);
          if (generation === this.readGeneration) this.publish({ document, loading: false });
        }
        this.observe();
      }
    })()
      .catch((error) => {
        if (!this.closed && (error as Error).name !== "AbortError")
          this.publish({ notice: String(error) });
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  /** Replace observation demand whenever expansion or document selection changes. */
  private observe() {
    this.stopObservation?.();
    if (this.closed) return;

    const keys = [...this.snapshot.expanded];
    if (this.snapshot.documentKey) keys.push(this.snapshot.documentKey);
    this.stopObservation = this.source.observe?.(keys, () => {
      void this.refresh();
    });
  }

  /** Cancel pending reads and release every observer before terminal teardown. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.controller.abort();
    this.stopObservation?.();
    this.listeners.clear();
    this.directories.clear();
    this.closePromise = Promise.allSettled([
      ...this.listingRequests.values(),
      ...this.pendingReads,
      ...(this.refreshPromise ? [this.refreshPromise] : []),
    ]).then(() => undefined);
    return this.closePromise;
  }
}
