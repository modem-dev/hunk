/**
 * Fits status items, the inline prompt, and the keyboard-mode badge into one terminal row.
 *
 * Deterministic and theme-free: spans keep their symbolic tones, widths come from terminal cell
 * measurement, and the same input always yields the same placement. The badge is never dropped.
 * While a prompt is active it takes the whole left region; otherwise left items paint in set
 * order and right items sit beside the badge. On overflow the lowest-priority item is dropped
 * whole (newest first among equals) until the rest fit, and the last survivor is truncated with
 * an ellipsis. Prompt lead-ins truncate before consuming the input's minimum visible space.
 */
import { sanitizeTerminalLine } from "../../lib/terminalText";
import { measureTextWidth, sliceTextByWidth } from "../lib/text";
import type { StatusItem, StatusSpan } from "./types";

/** Cells of horizontal padding on each side of the row. */
export const STATUS_LINE_PADDING = 1;
/** Cells separating two adjacent items, or an item from the badge. */
const ITEM_GAP = 2;
const BADGE_GAP = 1;
/** Reserve this many input cells whenever the row and non-droppable badge leave enough room. */
const MIN_PROMPT_INPUT_WIDTH = 4;
const ELLIPSIS = "…";

/** What a prompt needs from the layout: its painted lead-in and how wide the input may be. */
export interface StatusPromptLayoutInput {
  readonly prefix: string;
  readonly attribution: string | null;
}

export interface StatusLineLayoutInput {
  readonly items: readonly StatusItem[];
  readonly prompt: StatusPromptLayoutInput | null;
  /** The keyboard-mode badge text, or `null` when no mode is active. */
  readonly badge: string | null;
  /** Full terminal width the row spans. */
  readonly width: number;
}

/** One item after fitting: sanitized spans, possibly truncated, plus the width they occupy. */
export interface PlacedStatusItem {
  readonly id: string;
  readonly spans: readonly StatusSpan[];
  readonly width: number;
}

export interface StatusLineLayout {
  readonly left: readonly PlacedStatusItem[];
  readonly prompt: { prefix: string; attribution: string | null; inputWidth: number } | null;
  readonly right: readonly PlacedStatusItem[];
  readonly badge: { text: string; width: number } | null;
}

/** Sanitize one item's spans and measure them, dropping spans that end up empty. */
function placeItem(item: StatusItem): PlacedStatusItem | null {
  const spans: StatusSpan[] = [];
  let width = 0;
  for (const span of item.spans) {
    const text = sanitizeTerminalLine(span.text);
    if (text.length === 0) continue;
    spans.push({ ...span, text });
    width += measureTextWidth(text);
  }
  if (spans.length === 0) return null;
  return { id: item.id, spans, width };
}

/** Clip one placed item to `width` cells, ending it with an ellipsis. */
function truncateItem(item: PlacedStatusItem, width: number): PlacedStatusItem | null {
  if (width <= 0) return null;
  if (item.width <= width) return item;
  const ellipsisWidth = measureTextWidth(ELLIPSIS);
  let remaining = Math.max(0, width - ellipsisWidth);
  const spans: StatusSpan[] = [];
  for (const span of item.spans) {
    const spanWidth = measureTextWidth(span.text);
    if (spanWidth <= remaining) {
      spans.push(span);
      remaining -= spanWidth;
      continue;
    }
    const sliced = sliceTextByWidth(span.text, 0, remaining);
    spans.push({ ...span, text: `${sliced.text}${ELLIPSIS}` });
    return { id: item.id, spans, width: width - (remaining - sliced.width) };
  }
  // Every span fit under the reduced budget, so the ellipsis lands on its own.
  spans.push({ text: ELLIPSIS });
  return { id: item.id, spans, width: width - remaining };
}

/** Width of a run of items with the standard gap between neighbors. */
function itemsWidth(items: readonly PlacedStatusItem[]) {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item.width, 0) + ITEM_GAP * (items.length - 1);
}

interface ItemCandidate {
  item: PlacedStatusItem;
  right: boolean;
  priority: number;
  order: number;
}

/** Width the left and right runs occupy together, including the gap that separates them. */
function candidatesWidth(candidates: readonly ItemCandidate[]) {
  const left = candidates.filter((entry) => !entry.right).map((entry) => entry.item);
  const right = candidates.filter((entry) => entry.right).map((entry) => entry.item);
  const gap = left.length > 0 && right.length > 0 ? ITEM_GAP : 0;
  return itemsWidth(left) + gap + itemsWidth(right);
}

/**
 * Drop and truncate items until they fit `available` cells.
 *
 * Candidates keep their display order; the drop order is ascending priority across both
 * alignments, newest first among equal priorities, so the item a consumer set most recently is
 * the first casualty of its tier. The last survivor is truncated unless `truncate` is off.
 */
function fitItems(
  candidates: readonly ItemCandidate[],
  available: number,
  options: { truncate: boolean } = { truncate: true },
): { left: PlacedStatusItem[]; right: PlacedStatusItem[] } {
  let surviving = [...candidates];
  while (surviving.length > 1 && candidatesWidth(surviving) > available) {
    let victim = 0;
    for (let index = 1; index < surviving.length; index += 1) {
      const candidate = surviving[index]!;
      const current = surviving[victim]!;
      if (
        candidate.priority < current.priority ||
        (candidate.priority === current.priority && candidate.order > current.order)
      ) {
        victim = index;
      }
    }
    surviving = surviving.filter((_, index) => index !== victim);
  }
  if (surviving.length === 1 && surviving[0]!.item.width > available) {
    const truncated = options.truncate ? truncateItem(surviving[0]!.item, available) : null;
    surviving = truncated ? [{ ...surviving[0]!, item: truncated }] : [];
  }
  return {
    left: surviving.filter((entry) => !entry.right).map((entry) => entry.item),
    right: surviving.filter((entry) => entry.right).map((entry) => entry.item),
  };
}

/** Fit every status contribution into one row of `width` cells. */
export function layoutStatusLine(input: StatusLineLayoutInput): StatusLineLayout {
  const rowWidth = Math.max(0, input.width - STATUS_LINE_PADDING * 2);

  const badgeText = input.badge ? sanitizeTerminalLine(input.badge) : "";
  const badge =
    badgeText.length > 0
      ? {
          text: badgeText,
          width: Math.min(
            measureTextWidth(badgeText) + 2,
            Math.max(6, Math.floor(input.width / 2)),
          ),
        }
      : null;
  const available = Math.max(0, rowWidth - (badge ? badge.width + BADGE_GAP : 0));

  const candidates: ItemCandidate[] = [];
  input.items.forEach((item, order) => {
    const placed = placeItem(item);
    if (!placed) return;
    candidates.push({
      item: placed,
      right: item.alignment === "right",
      priority: item.priority ?? 0,
      order,
    });
  });

  if (input.prompt) {
    let attribution = input.prompt.attribution
      ? sanitizeTerminalLine(input.prompt.attribution)
      : null;
    let prefix = sanitizeTerminalLine(input.prompt.prefix);
    let leadWidth =
      (attribution ? measureTextWidth(attribution) + 1 : 0) +
      (prefix.length > 0 ? measureTextWidth(prefix) + 1 : 0);
    const leadBudget = Math.max(0, available - MIN_PROMPT_INPUT_WIDTH);
    if (leadWidth > leadBudget) {
      // Treat attribution and prefix as one lead-in, retaining the third-party marker first.
      // Its trailing space and ellipsis also consume cells; omit it if neither can fit.
      const lead = [attribution, prefix].filter(Boolean).join(" ");
      const truncated =
        leadBudget >= 2 ? `${sliceTextByWidth(lead, 0, leadBudget - 2).text}${ELLIPSIS}` : "";
      if (attribution) {
        attribution = truncated || null;
        prefix = "";
      } else {
        prefix = truncated;
      }
      leadWidth = truncated ? measureTextWidth(truncated) + 1 : 0;
    }
    // Right items keep their place only whole, and only while the input keeps its minimum: a
    // clipped status fragment beside a prompt reads as noise rather than information.
    const rightBudget = available - leadWidth - MIN_PROMPT_INPUT_WIDTH - ITEM_GAP;
    const right =
      rightBudget > 0
        ? fitItems(
            candidates.filter((entry) => entry.right),
            rightBudget,
            { truncate: false },
          ).right
        : [];
    const rightWidth = right.length > 0 ? itemsWidth(right) + ITEM_GAP : 0;
    const inputWidth = Math.max(0, available - leadWidth - rightWidth);
    return { left: [], prompt: { prefix, attribution, inputWidth }, right, badge };
  }

  const { left, right } = fitItems(candidates, available);
  return { left, prompt: null, right, badge };
}
