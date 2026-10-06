/** Describe lazy document collections without introducing diff or review semantics. */
export interface DocumentEntry {
  /** Opaque source-owned identity; consumers must not resolve it as a filesystem path. */
  key: string;
  name: string;
  /** Optional display/language hint, never an authority for source reads or editor paths. */
  displayPath?: string;
  kind: "directory" | "file" | "symlink" | "special";
  hidden: boolean;
  ignored?: boolean;
  status?: string;
}

export type DocumentReadResult =
  | { kind: "text"; text: string; identity: string; language?: string }
  | {
      kind: "unavailable";
      reason: "binary" | "too-large" | "symlink" | "special" | "missing" | "unreadable";
      detail: string;
    };

export type DirectoryReadResult =
  | { kind: "entries"; entries: readonly DocumentEntry[] }
  | { kind: "unavailable"; detail: string };

/** Serve bounded lazy reads, with observation and editing supplied as explicit capabilities. */
export interface DocumentSource {
  root: DocumentEntry;
  read(key: string, signal?: AbortSignal): Promise<DocumentReadResult>;
  list(key: string, signal?: AbortSignal): Promise<DirectoryReadResult>;
  /** Observe only demanded entries; disposing releases every watcher owned by this subscription. */
  observe?(keys: readonly string[], onChange: () => void): () => void;
  /** Resolve an explicitly selected regular document for an external editor, not arbitrary paths. */
  editablePath?(key: string): Promise<string | null>;
}
