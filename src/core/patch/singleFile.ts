import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

/**
 * Parse a patch that covers exactly one file and label it with the real path.
 *
 * Synthetic one-file patches — an untracked file rendered as an addition, a
 * backend that emits one file at a time — carry whatever path spelling the
 * producing tool chose: shell-quoted, escaped, or `/dev/null` on the missing
 * side. The caller always knows the true repo-root-relative path, so the parsed
 * metadata is relabeled with it rather than trusting the header round-trip.
 */
export function parseSingleFilePatch(
  patchText: string,
  filePath: string,
  previousPath?: string,
): FileDiffMetadata {
  let parsedPatches: ReturnType<typeof parsePatchFiles>;

  try {
    parsedPatches = parsePatchFiles(patchText, "patch", true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse untracked file patch for ${JSON.stringify(filePath)}: ${message}`,
    );
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  if (metadataFiles.length !== 1) {
    throw new Error(
      `Expected one parsed file for untracked patch ${JSON.stringify(filePath)}, got ${metadataFiles.length}.`,
    );
  }

  const metadata = metadataFiles[0]!;
  return {
    ...metadata,
    name: filePath,
    prevName: previousPath,
  } satisfies FileDiffMetadata;
}
