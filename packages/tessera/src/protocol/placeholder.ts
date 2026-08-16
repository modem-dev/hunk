/**
 * Builds Unicode placeholder cells for virtual image placements.
 *
 * A virtual placement (U=1) has no fixed screen position. Instead the image is
 * drawn wherever placeholder cells appear, which puts it in the normal text
 * grid: it scrolls with the buffer, clips at the viewport, and is overwritten by
 * text like any other cell. That is what makes images usable inside a scrolling
 * document rather than pinned to an absolute location.
 *
 * Each cell carries the placeholder character, a row diacritic, and a column
 * diacritic. The image id travels in the cell's foreground color (low 24 bits),
 * with a third diacritic supplying the most significant byte when the id needs
 * one. Placement ids ride in the underline color.
 */
import { diacriticFor, MAX_PLACEHOLDER_INDEX } from "./diacritics";

/** U+10EEEE, the character kitty reserves for image placeholders. */
export const PLACEHOLDER_CHAR = String.fromCodePoint(0x10eeee);

const ESC = String.fromCharCode(0x1b);
const SGR_RESET = `${ESC}[39;59m`;

export interface PlaceholderOptions {
  /** Image id of the virtual placement being addressed. */
  id: number;
  rows: number;
  cols: number;
  /** Placement id, when the image has more than one virtual placement. */
  placementId?: number;
  /**
   * Emits a diacritic on every cell. Kitty can infer runs of consecutive
   * columns, so leaving this off produces markedly shorter rows; turn it on when
   * cells may be written out of order or individually overwritten.
   */
  explicitColumns?: boolean;
}

/** Splits the low 24 bits of an id into the RGB channels that carry it. */
function idToRgb(id: number): [number, number, number] {
  return [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff];
}

/** Sets the foreground color that identifies which image these cells belong to. */
function foregroundFor(id: number): string {
  const [r, g, b] = idToRgb(id);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/** Sets the underline color that selects among an image's placements. */
function underlineFor(placementId: number): string {
  const [r, g, b] = idToRgb(placementId);
  return `${ESC}[58:2::${r}:${g}:${b}m`;
}

/**
 * Renders the placeholder grid as one string per row.
 *
 * Rows are returned separately because the caller owns cursor positioning; the
 * strings contain no movement sequences, only styling and cells.
 */
export function placeholderRows(opts: PlaceholderOptions): string[] {
  const { id, rows, cols } = opts;
  if (rows <= 0 || cols <= 0) return [];
  if (rows > MAX_PLACEHOLDER_INDEX + 1 || cols > MAX_PLACEHOLDER_INDEX + 1) {
    throw new Error(
      `placement of ${cols}x${rows} exceeds the ${MAX_PLACEHOLDER_INDEX + 1} addressable rows/columns`,
    );
  }

  // Ids above 24 bits need their top byte carried as a third diacritic, because
  // the foreground color only has three channels to spend.
  const highByte = (id >> 24) & 0xff;
  const highDiacritic = highByte === 0 ? "" : (diacriticFor(highByte) ?? "");
  if (highByte !== 0 && highDiacritic === "") {
    throw new Error(`image id ${id} has a high byte that cannot be encoded`);
  }

  const prefix =
    foregroundFor(id) + (opts.placementId === undefined ? "" : underlineFor(opts.placementId));
  const out: string[] = [];
  for (let row = 0; row < rows; row++) {
    const rowMark = diacriticFor(row) ?? "";
    let line = prefix;
    for (let col = 0; col < cols; col++) {
      line += PLACEHOLDER_CHAR + rowMark;
      // The column diacritic can be dropped after the first cell: kitty continues
      // the run, and skipping it roughly halves the bytes for a wide placement.
      if (col === 0 || opts.explicitColumns) line += diacriticFor(col) ?? "";
      if (highDiacritic !== "") line += highDiacritic;
    }
    out.push(line + SGR_RESET);
  }
  return out;
}

/** Reports whether a placement of this size can be addressed by placeholder cells. */
export function fitsPlaceholderGrid(rows: number, cols: number): boolean {
  return (
    rows > 0 && cols > 0 && rows <= MAX_PLACEHOLDER_INDEX + 1 && cols <= MAX_PLACEHOLDER_INDEX + 1
  );
}
