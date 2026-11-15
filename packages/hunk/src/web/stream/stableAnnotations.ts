/**
 * Keeps a file's Pierre line annotations identical across rebuilds whose content did not change.
 *
 * Pierre redraws an annotation (a new slot element, so a new composer root) whenever its
 * `metadata` is a different object, and the page rebuilds every annotation each time the
 * shared state moves, even when no note on that line changed. An agent comment landing
 * elsewhere would then tear down an open composer, losing the reader's focus, an unfinished
 * "Discard this draft?" confirmation and any input-method composition. Each rebuilt
 * annotation here keeps the previous object when its side, line and metadata serialize alike,
 * and the whole list keeps its previous identity when nothing changed.
 */
import type { DiffLineAnnotation } from "@pierre/diffs";

/** What one rebuild remembers for the next. */
export interface StableAnnotations<Metadata extends { key: string }> {
  readonly list: DiffLineAnnotation<Metadata>[];
  readonly byKey: ReadonlyMap<
    string,
    { signature: string; annotation: DiffLineAnnotation<Metadata> }
  >;
}

/** Reuse the previous annotations whose content is unchanged. */
export function stabilizeLineAnnotations<Metadata extends { key: string }>(
  previous: StableAnnotations<Metadata> | undefined,
  next: readonly DiffLineAnnotation<Metadata>[],
): StableAnnotations<Metadata> {
  const byKey = new Map<string, { signature: string; annotation: DiffLineAnnotation<Metadata> }>();
  const list = next.map((annotation) => {
    const signature = JSON.stringify([annotation.side, annotation.lineNumber, annotation.metadata]);
    const kept = previous?.byKey.get(annotation.metadata.key);
    const stable = kept && kept.signature === signature ? kept.annotation : annotation;
    byKey.set(annotation.metadata.key, { signature, annotation: stable });
    return stable;
  });
  const unchanged =
    previous !== undefined &&
    previous.list.length === list.length &&
    previous.list.every((annotation, position) => annotation === list[position]);
  return { list: unchanged ? previous.list : list, byKey };
}
