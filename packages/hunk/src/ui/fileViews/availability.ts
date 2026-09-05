export const FILE_VIEW_DRAFT_UNAVAILABLE_REASON =
  "File presentations are unavailable while drafting an inline review note • using raw diff";

/** Draft editing remains raw-only; committed notes are resolved from validated source bindings. */
export function fileViewUnavailableReason({ hasDraftNote }: { hasDraftNote: boolean }) {
  return hasDraftNote ? FILE_VIEW_DRAFT_UNAVAILABLE_REASON : null;
}

/**
 * The view key one file is actually presenting, or `null` when it shows raw diff.
 *
 * The single-file form of {@link availableFileViewSelections}, and the one
 * answer behind both `fileViews.isActive` and every file-view mode decision:
 * reading the stored choice alone would claim a presentation for a file the
 * host is currently keeping on raw diff.
 */
export function presentedFileViewKey(
  selections: Readonly<Record<string, string>>,
  unavailableReasons: ReadonlyMap<string, string>,
  fileId: string | null,
): string | null {
  if (!fileId || unavailableReasons.has(fileId)) return null;
  return selections[fileId] ?? null;
}

/** Mask stored choices only while a host constraint requires raw rendering. */
export function availableFileViewSelections(
  selections: Readonly<Record<string, string>>,
  unavailableReasons: ReadonlyMap<string, string>,
) {
  if (unavailableReasons.size === 0) return selections;

  const available: Record<string, string> = {};
  let masked = false;
  for (const [fileId, viewKey] of Object.entries(selections)) {
    if (unavailableReasons.has(fileId)) {
      masked = true;
    } else {
      available[fileId] = viewKey;
    }
  }
  return masked ? available : selections;
}
