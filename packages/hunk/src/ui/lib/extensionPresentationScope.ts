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

/** Build a scope store that rejects stale or malformed extension presentation requests. */
export function createExtensionPresentationScopeStore(
  options: ExtensionPresentationScopeStoreOptions,
): ExtensionPresentationScopeStore {
  const scopes = new Map<string, ExtensionReviewPresentationScope>();

  const notify = () => options.onChange();
  const current = (): ExtensionReviewPresentationScope | null => {
    const generation = options.getGeneration();
    if (!generation) return null;
    const entries = [...scopes.values()].filter((scope) => scope.generation === generation);
    if (entries.length === 0) return null;

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

    return Object.freeze({
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
  };

  return {
    set(extensionId, scope) {
      const generation = options.getGeneration();
      if (!generation || scope.generation !== generation) return false;
      const filesById = new Map(options.getFiles().map((file) => [file.id, file]));
      const files = scope.files.map((entry) => normalizeScopeFile(entry, filesById));
      if (files.length === 0 || files.some((entry) => entry === null)) return false;
      scopes.set(
        extensionId,
        Object.freeze({
          generation,
          files: Object.freeze(files as ExtensionReviewPresentationScopeFile[]),
        }),
      );
      notify();
      return true;
    },
    clear(extensionId) {
      if (scopes.delete(extensionId)) notify();
    },
    clearAll() {
      if (scopes.size === 0) return;
      scopes.clear();
      notify();
    },
    get: current,
  };
}
