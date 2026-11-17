/**
 * Formats the line and file counts the browser page prints.
 *
 * Counts group their digits with the `en-US` separator (`25,048`) so the text does not depend on
 * the viewer's locale, and removals use a true minus sign (`−47`) so they align with `+`.
 * Terminal output keeps its own plain formatting in `core/`.
 */
const GROUPED = new Intl.NumberFormat("en-US");

/** A whole number with grouped digits. */
export function formatCount(value: number): string {
  return GROUPED.format(value);
}

/** `+25,048`, with a trailing `+` when the producer truncated the count. */
export function formatAddedCount(value: number, truncated = false): string {
  return `+${formatCount(value)}${truncated ? "+" : ""}`;
}

/** `−47`, with a true minus sign. */
export function formatRemovedCount(value: number): string {
  return `−${formatCount(value)}`;
}

/** `1 file` or `2,000 files`. */
export function formatFileCount(value: number): string {
  return value === 1 ? "1 file" : `${formatCount(value)} files`;
}

/** An added-lines badge that hides a zero, for the sidebar and pickers. */
export function formatAddedBadge(value: number, truncated = false): string | null {
  return value > 0 ? formatAddedCount(value, truncated) : null;
}

/** A removed-lines badge that hides a zero, for the sidebar and pickers. */
export function formatRemovedBadge(value: number): string | null {
  return value > 0 ? formatRemovedCount(value) : null;
}
