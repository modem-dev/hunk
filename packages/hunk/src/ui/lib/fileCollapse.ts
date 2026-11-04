/**
 * Decides which files the terminal review collapses and builds the variant that shows them.
 *
 * A collapsed file becomes a file with no hunks, which rendering, geometry, windowing, and hunk
 * navigation already handle. Collapse is terminal presentation state: the canonical files, the
 * review document, and everything published to the session daemon keep the full diff.
 */
import { createSkippedLargeMetadata } from "../../core/changeset/diffFile";
import type { DiffFile } from "../../core/changeset/model";

// One variant per source file keeps object identity stable for the geometry cache.
const COLLAPSED_VARIANTS = new WeakMap<DiffFile, DiffFile>();

/** Build or reuse the placeholder variant shown in place of one collapsed file. */
export function collapsedFileVariant(file: DiffFile): DiffFile {
  const cached = COLLAPSED_VARIANTS.get(file);
  if (cached) return cached;

  const variant: DiffFile = {
    ...file,
    metadata: createSkippedLargeMetadata(file.path, file.metadata.type),
    isCollapsedPlaceholder: true,
  };
  COLLAPSED_VARIANTS.set(file, variant);
  return variant;
}

/**
 * Report whether a generated file starts collapsed.
 *
 * Notes keep a file open because someone has pointed the reviewer at its contents, and an
 * extension's presentation scope has chosen exactly which hunks to show.
 */
function collapsesByDefault(file: DiffFile, collapseGenerated: boolean, scoped: boolean) {
  return (
    collapseGenerated &&
    !scoped &&
    file.reviewNoise !== undefined &&
    (file.agent?.annotations.length ?? 0) === 0
  );
}

/** Replace collapsed files with placeholders, letting the reviewer's choice beat the default. */
export function applyFileCollapse({
  files,
  keyByFileId,
  overrides,
  collapseGenerated,
  scoped,
}: {
  files: DiffFile[];
  keyByFileId: ReadonlyMap<string, string>;
  /** The reviewer's explicit choices by stable file key, true meaning collapsed. */
  overrides: ReadonlyMap<string, boolean>;
  collapseGenerated: boolean;
  scoped: boolean;
}): DiffFile[] {
  return files.map((file) => {
    if (file.metadata.hunks.length === 0) return file;

    const fileKey = keyByFileId.get(file.id);
    const override = fileKey === undefined ? undefined : overrides.get(fileKey);
    const collapsed = override ?? collapsesByDefault(file, collapseGenerated, scoped);
    return collapsed ? collapsedFileVariant(file) : file;
  });
}
