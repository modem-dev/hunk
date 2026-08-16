/**
 * Encodes kitty graphics protocol control sequences.
 *
 * Every function here is pure: it returns strings and never touches a stream,
 * so the wire format can be unit-tested without a terminal. Callers own writing
 * and ordering. Payload chunking follows the protocol's 4096-byte base64 limit,
 * with non-final chunks kept at a multiple of 4 so no base64 quantum is split.
 */

/** Pixel layout of transmitted data: RGB, RGBA, or a PNG container. */
export type TransmitFormat = 24 | 32 | 100;

/**
 * Where the terminal reads pixel data from. `direct` inlines base64 in the
 * escape sequence; the rest name something on the filesystem or in shared
 * memory and keep the payload off the pty entirely.
 */
export type TransmitMedium = "direct" | "file" | "tempfile" | "shared";

/** Suppresses terminal replies: 0 responds, 1 drops OK, 2 drops all responses. */
export type Quietness = 0 | 1 | 2;

const MEDIUM_KEY: Record<TransmitMedium, string> = {
  direct: "d",
  file: "f",
  tempfile: "t",
  shared: "s",
};

/** Base64 payload budget per escape sequence, per the protocol. */
export const MAX_CHUNK_BYTES = 4096;

export interface TransmitOptions {
  /** Client-assigned image id (1..4294967295); later placements reference it. */
  id: number;
  format?: TransmitFormat;
  medium?: TransmitMedium;
  /** Required for raw formats (f=24/f=32); ignored for PNG, which is self-describing. */
  width?: number;
  height?: number;
  /** Marks the payload as zlib-deflated (o=z). Valid for raw and PNG data alike. */
  compressed?: boolean;
  quiet?: Quietness;
  /** Transmits and places in one action (a=T) using these placement settings. */
  display?: Omit<PlacementOptions, "id">;
}

export interface PlacementOptions {
  id: number;
  /** Distinguishes multiple simultaneous placements of one image. */
  placementId?: number;
  /** Destination box in cells; omitting one derives it from the source aspect ratio. */
  cols?: number;
  rows?: number;
  /** Source rectangle in pixels, for drawing one sprite out of a packed atlas. */
  srcX?: number;
  srcY?: number;
  srcW?: number;
  srcH?: number;
  /** Stacking order. Negative draws under text, which is how chrome sits behind glyphs. */
  z?: number;
  /** Pixel offset within the starting cell. */
  offsetX?: number;
  offsetY?: number;
  /** Leaves the cursor where it was (C=1) instead of advancing it past the image. */
  keepCursor?: boolean;
  /** Creates a virtual placement (U=1) addressed later by placeholder cells. */
  virtual?: boolean;
  quiet?: Quietness;
}

/** Control bytes for the APC envelope, kept as char codes so no literal ESC lands in source. */
const ESC = String.fromCharCode(0x1b);
const BACKSLASH = String.fromCharCode(0x5c);
const APC_START = ESC + "_G";
const APC_END = ESC + BACKSLASH;

/** Builds one APC graphics sequence: ESC _ G <keys> ; <payload> ESC backslash. */
function sequence(keys: string, payload = ""): string {
  return APC_START + keys + ";" + payload + APC_END;
}

/** Serializes defined key/value pairs in the protocol's comma-separated form. */
function keyList(pairs: Array<[string, number | string | undefined]>): string {
  return pairs
    .filter((pair): pair is [string, number | string] => pair[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** Collects the placement keys shared by `a=p` and the combined `a=T` form. */
function placementKeys(opts: Omit<PlacementOptions, "id">): Array<[string, number | undefined]> {
  return [
    ["p", opts.placementId],
    ["x", opts.srcX],
    ["y", opts.srcY],
    ["w", opts.srcW],
    ["h", opts.srcH],
    ["c", opts.cols],
    ["r", opts.rows],
    ["X", opts.offsetX],
    ["Y", opts.offsetY],
    ["z", opts.z],
    ["C", opts.keepCursor ? 1 : undefined],
    ["U", opts.virtual ? 1 : undefined],
  ];
}

/**
 * Splits base64 text into protocol-legal chunks.
 *
 * Non-final chunks must be a multiple of 4 so a base64 quantum never straddles
 * two escape sequences; MAX_CHUNK_BYTES already satisfies that.
 */
export function chunkBase64(encoded: string, size = MAX_CHUNK_BYTES): string[] {
  if (size % 4 !== 0) throw new Error(`chunk size must be a multiple of 4, got ${size}`);
  if (encoded.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += size) chunks.push(encoded.slice(i, i + size));
  return chunks;
}

/**
 * Encodes an image transmission as one escape sequence per chunk.
 *
 * The first sequence carries the full key set; continuations carry only the
 * `m` flag, which is what the protocol expects and keeps the tail chunks small.
 * With `display` set the action becomes `a=T`, transmitting and placing at once.
 */
export function encodeTransmit(payload: Uint8Array, opts: TransmitOptions): string[] {
  const medium = opts.medium ?? "direct";
  const format = opts.format ?? 32;
  if (
    format !== 100 &&
    medium === "direct" &&
    (opts.width === undefined || opts.height === undefined)
  ) {
    throw new Error("raw pixel formats require width and height");
  }
  const encoded = Buffer.from(payload).toString("base64");
  const chunks = chunkBase64(encoded);
  const head = keyList([
    ["a", opts.display ? "T" : "t"],
    ["f", format],
    ["t", MEDIUM_KEY[medium]],
    ["i", opts.id],
    ["s", opts.width],
    ["v", opts.height],
    ["o", opts.compressed ? "z" : undefined],
    ["q", opts.quiet],
    ...(opts.display ? placementKeys(opts.display) : []),
    ["m", chunks.length > 1 ? 1 : undefined],
  ]);

  const out = [sequence(head, chunks[0] ?? "")];
  for (let i = 1; i < chunks.length; i++) {
    out.push(sequence(`m=${i === chunks.length - 1 ? 0 : 1}`, chunks[i] ?? ""));
  }
  return out;
}

/**
 * Encodes a placement of an already-transmitted image (`a=p`).
 *
 * Placements are cheap next to transmission, which is what makes one packed
 * atlas plus many source-rectangle placements the efficient way to draw chrome.
 */
export function encodePlace(opts: PlacementOptions): string {
  return sequence(keyList([["a", "p"], ["i", opts.id], ...placementKeys(opts), ["q", opts.quiet]]));
}

/** Selects which images or placements a delete applies to. */
export type DeleteScope =
  | { kind: "all" }
  | { kind: "id"; id: number; placementId?: number }
  | { kind: "number"; number: number; placementId?: number }
  | { kind: "cursor" }
  | { kind: "cell"; column: number; row: number }
  | { kind: "cellWithZ"; column: number; row: number; z: number }
  | { kind: "column"; column: number }
  | { kind: "row"; row: number }
  | { kind: "z"; z: number }
  | { kind: "idRange"; from: number; to: number };

/**
 * Encodes a delete (`a=d`).
 *
 * `freeData` picks the uppercase selector, which releases the stored pixels as
 * well as the placement; the lowercase form only removes what is on screen and
 * keeps the image available for future placements.
 */
export function encodeDelete(scope: DeleteScope, freeData = false): string {
  const pick = (lower: string) => (freeData ? lower.toUpperCase() : lower);
  const pairs: Array<[string, number | string | undefined]> = [["a", "d"]];
  switch (scope.kind) {
    case "all":
      pairs.push(["d", pick("a")]);
      break;
    case "id":
      pairs.push(["d", pick("i")], ["i", scope.id], ["p", scope.placementId]);
      break;
    case "number":
      pairs.push(["d", pick("n")], ["I", scope.number], ["p", scope.placementId]);
      break;
    case "cursor":
      pairs.push(["d", pick("c")]);
      break;
    case "cell":
      pairs.push(["d", pick("p")], ["x", scope.column], ["y", scope.row]);
      break;
    case "cellWithZ":
      pairs.push(["d", pick("q")], ["x", scope.column], ["y", scope.row], ["z", scope.z]);
      break;
    case "column":
      pairs.push(["d", pick("x")], ["x", scope.column]);
      break;
    case "row":
      pairs.push(["d", pick("y")], ["y", scope.row]);
      break;
    case "z":
      pairs.push(["d", pick("z")], ["z", scope.z]);
      break;
    case "idRange":
      pairs.push(["d", pick("r")], ["x", scope.from], ["y", scope.to]);
      break;
  }
  return sequence(keyList(pairs));
}

/** Asks the terminal whether it speaks the graphics protocol at all. */
export function encodeSupportQuery(id = 31): string {
  return sequence(
    keyList([
      ["a", "q"],
      ["i", id],
      ["s", 1],
      ["v", 1],
      ["f", 24],
    ]),
    "AAAA",
  );
}
