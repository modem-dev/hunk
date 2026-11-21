/**
 * Picks the file the review bar's "Next unviewed" button points at: the first file after the
 * selected one, in review order and wrapping to the start, that is not marked viewed.
 *
 * A file changed since it was viewed counts as unviewed, as does a file whose mark has not
 * arrived yet. The selected file is the last candidate, so a review with one unviewed file left
 * points at it even while it is selected. With no selection the walk starts at the first file.
 */
import type { ReviewViewedStatus } from "./viewedFiles";

/** The next file not marked viewed, or nothing when every file is. */
export function nextUnviewedFile<T extends { key: string }>(
  files: readonly T[],
  selectedKey: string | null | undefined,
  statuses: ReadonlyMap<string, ReviewViewedStatus>,
): T | undefined {
  if (files.length === 0) return undefined;

  // The walk begins just after the selection; a selection outside the list starts at the top.
  const selectedIndex = selectedKey ? files.findIndex((file) => file.key === selectedKey) : -1;
  for (let step = 1; step <= files.length; step += 1) {
    const file = files[(selectedIndex + step + files.length) % files.length]!;
    if (statuses.get(file.key) !== "viewed") return file;
  }
  return undefined;
}
