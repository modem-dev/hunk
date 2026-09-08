import type { FileDiffMetadata } from "@pierre/diffs";

/** Remove parser-added CR/LF suffixes from diff paths without touching meaningful spaces. */
export function normalizeDiffPath(path: string | undefined) {
  return path?.replace(/[\r\n]+$/u, "");
}

/** Sanitize parsed diff metadata path fields before the UI or loaders consume them. */
export function normalizeDiffMetadataPaths(metadata: FileDiffMetadata): FileDiffMetadata {
  const name = normalizeDiffPath(metadata.name) ?? metadata.name;
  const prevName = normalizeDiffPath(metadata.prevName);

  if (name === metadata.name && prevName === metadata.prevName) {
    return metadata;
  }

  return {
    ...metadata,
    name,
    prevName,
  };
}
