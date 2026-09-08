import type { ReviewDocumentV1 } from "../../core/review/types";
import type { ValidatedLineHighlight } from "./validate";

/**
 * Carries agent attention marks across one review document reconcile.
 *
 * Marks name exact character offsets in one line of one file, and nothing re-derives them
 * after a reload the way extension highlighters re-run. A file that comes back with an
 * unchanged `contentIdentity` still shows the same characters on the same lines, so its
 * marks stay valid and are re-keyed onto the replacement's runtime id. Marks belonging to
 * a file that left the review, or came back with different content, are dropped rather
 * than left lighting up text nobody marked.
 */
export function carryOverLineHighlights(
  marksByFileId: ReadonlyMap<string, readonly ValidatedLineHighlight[]>,
  previous: ReviewDocumentV1,
  next: ReviewDocumentV1,
): ReadonlyMap<string, readonly ValidatedLineHighlight[]> {
  const carried = new Map<string, readonly ValidatedLineHighlight[]>();
  if (marksByFileId.size === 0) {
    return carried;
  }

  const nextByKey = new Map(next.files.map((file) => [file.key, file] as const));
  for (const file of previous.files) {
    const marks = marksByFileId.get(file.runtimeId);
    if (!marks || marks.length === 0) {
      continue;
    }

    const replacement = nextByKey.get(file.key);
    if (!replacement || replacement.contentIdentity !== file.contentIdentity) {
      continue;
    }

    carried.set(replacement.runtimeId, marks);
  }

  return carried;
}
