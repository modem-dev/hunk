import type { DiffFile } from "../../core/changeset/model";
import type {
  ExtensionReviewPresentationScope,
  ExtensionReviewPresentationScopeFile,
} from "../../extension-api/types";

/** Own one extension's transient, generation-bound review presentation scope. */
export interface ExtensionPresentationScopeStore {
  set(extensionId: string, scope: ExtensionReviewPresentationScope): boolean;
  clear(extensionId: string): void;
  clearAll(): void;
  get(): ExtensionReviewPresentationScope | null;
}

/** Apply an extension scope after the existing user file filter, preserving review order. */
export function filterFilesByExtensionPresentationScope(
  files: readonly DiffFile[],
  scope: ExtensionReviewPresentationScope | null,
): DiffFile[] {
  if (!scope) return [...files];
  const visibleFileIds = new Set(scope.files.map((entry) => entry.fileId));
  return files.filter((file) => visibleFileIds.has(file.id));
}

interface ExtensionPresentationScopeStoreOptions {
  getGeneration: () => string | null;
  getFiles: () => readonly DiffFile[];
  onChange: () => void;
}

/** Validate one scope entry against the currently mounted runtime diff files. */
function normalizeScopeFile(
  entry: ExtensionReviewPresentationScopeFile,
  filesById: ReadonlyMap<string, DiffFile>,
): ExtensionReviewPresentationScopeFile | null {
  if (typeof entry.fileId !== "string" || entry.fileId.length === 0) return null;
  const file = filesById.get(entry.fileId);
  if (!file || !Array.isArray(entry.hunkIndexes) || entry.hunkIndexes.length === 0) return null;

  const hunkIndexes = [...new Set(entry.hunkIndexes)];
  if (
    hunkIndexes.some(
      (index) => !Number.isSafeInteger(index) || index < 0 || index >= file.metadata.hunks.length,
    )
  ) {
    return null;
  }
  hunkIndexes.sort((left, right) => left - right);
  return Object.freeze({ fileId: entry.fileId, hunkIndexes: Object.freeze(hunkIndexes) });
}

/** Compare normalized scope entries without treating recreated arrays as changes. */
function sameScopeFiles(
  left: readonly ExtensionReviewPresentationScopeFile[],
  right: readonly ExtensionReviewPresentationScopeFile[],
) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.fileId === right[index]?.fileId &&
        entry.hunkIndexes.length === right[index]?.hunkIndexes.length &&
        entry.hunkIndexes.every(
          (hunkIndex, hunkPosition) => hunkIndex === right[index]?.hunkIndexes[hunkPosition],
        ),
    )
  );
}

/** Build a scope store that rejects stale or malformed extension presentation requests. */
export function createExtensionPresentationScopeStore(
  options: ExtensionPresentationScopeStoreOptions,
): ExtensionPresentationScopeStore {
  const scopes = new Map<string, ExtensionReviewPresentationScope>();
  let mutationRevision = 0;
  let cachedGeneration: string | null | undefined;
  let cachedRevision = -1;
  let cachedScope: ExtensionReviewPresentationScope | null = null;

  const notify = () => options.onChange();
  const current = (): ExtensionReviewPresentationScope | null => {
    const generation = options.getGeneration();
    if (cachedRevision === mutationRevision && cachedGeneration === generation) {
      return cachedScope;
    }
    cachedGeneration = generation;
    cachedRevision = mutationRevision;
    if (!generation) {
      cachedScope = null;
      return cachedScope;
    }
    const entries = [...scopes.values()].filter((scope) => scope.generation === generation);
    if (entries.length === 0) {
      cachedScope = null;
      return cachedScope;
    }

    let files = entries[0]!.files.map((entry) => ({
      fileId: entry.fileId,
      hunkIndexes: new Set(entry.hunkIndexes),
    }));
    for (const scope of entries.slice(1)) {
      const next = new Map(scope.files.map((entry) => [entry.fileId, new Set(entry.hunkIndexes)]));
      files = files.flatMap((entry) => {
        const hunkIndexes = next.get(entry.fileId);
        if (!hunkIndexes) return [];
        return [
          {
            fileId: entry.fileId,
            hunkIndexes: new Set([...entry.hunkIndexes].filter((index) => hunkIndexes.has(index))),
          },
        ];
      });
    }

    cachedScope = Object.freeze({
      generation,
      files: Object.freeze(
        files
          .filter((entry) => entry.hunkIndexes.size > 0)
          .map((entry) =>
            Object.freeze({
              fileId: entry.fileId,
              hunkIndexes: Object.freeze(
                [...entry.hunkIndexes].sort((left, right) => left - right),
              ),
            }),
          ),
      ),
    });
    return cachedScope;
  };

  return {
    set(extensionId, scope) {
      const generation = options.getGeneration();
      if (!generation || scope.generation !== generation) return false;
      const filesById = new Map(options.getFiles().map((file) => [file.id, file]));
      const files = scope.files.map((entry) => normalizeScopeFile(entry, filesById));
      if (files.length === 0 || files.some((entry) => entry === null)) return false;
      const normalizedFiles = files as ExtensionReviewPresentationScopeFile[];
      const previous = scopes.get(extensionId);
      if (previous?.generation === generation && sameScopeFiles(previous.files, normalizedFiles)) {
        return true;
      }
      scopes.set(
        extensionId,
        Object.freeze({
          generation,
          files: Object.freeze(normalizedFiles),
        }),
      );
      mutationRevision += 1;
      notify();
      return true;
    },
    clear(extensionId) {
      if (!scopes.delete(extensionId)) return;
      mutationRevision += 1;
      notify();
    },
    clearAll() {
      if (scopes.size === 0) return;
      scopes.clear();
      mutationRevision += 1;
      notify();
    },
    get: current,
  };
}
