/**
 * Scores how well a typed query matches a label, for the palette and go-to-file.
 *
 * Every query character must appear in order (case-insensitive); consecutive runs, matches at
 * the start of a word or path segment, and shorter labels score higher. A query that is not a
 * subsequence of the label does not match at all, so the lists never show unrelated rows.
 */

/** Characters after which a match counts as the start of a word. */
const WORD_BOUNDARY = /[\s/._\-:]/;

/** The score of `query` against `text`, or undefined when it does not match. */
export function fuzzyScore(query: string, text: string): number | undefined {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = text.toLowerCase();

  let score = 0;
  let position = 0;
  let previous = -2;
  for (const character of needle) {
    if (character === " ") continue;
    const found = haystack.indexOf(character, position);
    if (found < 0) return undefined;
    score += 1;
    if (found === previous + 1) score += 3;
    if (found === 0 || WORD_BOUNDARY.test(haystack[found - 1]!)) score += 2;
    previous = found;
    position = found + 1;
  }
  return score - haystack.length / 100;
}

/**
 * Order items by their best score against the query, dropping those that do not match.
 *
 * Ties keep their input order, so callers decide what comes first among equals.
 */
export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  labels: (item: T) => readonly string[],
): T[] {
  const scored = items.flatMap((item, index) => {
    const best = labels(item).reduce<number | undefined>((current, label) => {
      const score = fuzzyScore(query, label);
      return score === undefined ? current : Math.max(current ?? score, score);
    }, undefined);
    return best === undefined ? [] : [{ item, index, score: best }];
  });
  if (query.trim().length === 0) return scored.map((entry) => entry.item);
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}
