/**
 * Finds the characters in repository text that can make it look different from what it is,
 * so every review surface can show them instead of letting them act.
 *
 * Two kinds count. Bidirectional controls (embeddings, overrides, isolates, and the
 * directional marks) reorder the text around them when a browser applies the Unicode bidi
 * algorithm, which is how a "Trojan Source" line (CVE-2021-42574) reads as a comment while it
 * compiles as code and how `file<U+202E>txt.exe` reads as `fileexe.txt`. Invisible characters
 * (zero-width spaces and joiners, word joiners, a mid-text byte-order mark, tag characters,
 * fillers) draw nothing, so two identifiers or paths that differ by one look the same.
 *
 * Legitimate text keeps its meaning: Arabic and Hebrew letters are never flagged, only the
 * control characters that override them; a zero-width joiner or non-joiner between two
 * non-ASCII characters (emoji sequences, Persian and Indic shaping) stays silent; tag
 * characters that follow a black flag (subdivision flags) stay silent; and a byte-order mark
 * that starts a file's first line can be exempted by the caller.
 *
 * Platform-free and dependency-free, so the browser bundle and the terminal can share it.
 * Offsets are UTF-16 code units, the unit `String.prototype.indexOf` and DOM text use.
 */
import type { ReviewFile } from "./types";

/** What a flagged character does: reorder the text around it, or draw nothing. */
export type ReviewHiddenCharacterKind = "bidi" | "invisible";

/** One flagged character inside a scanned text. */
export interface ReviewHiddenCharacter {
  /** UTF-16 offset of the character in the scanned text. */
  index: number;
  /** UTF-16 length: 2 for an astral tag character, otherwise 1. */
  length: number;
  codePoint: number;
  kind: ReviewHiddenCharacterKind;
}

/** A run of ordinary text, or exactly one flagged character. */
export interface ReviewHiddenTextSegment {
  text: string;
  hidden?: ReviewHiddenCharacter;
}

/** Which kinds of flagged characters one file's paths or lines contain. */
export interface ReviewHiddenTextFacts {
  bidi: boolean;
  invisible: boolean;
}

export interface ReviewHiddenTextOptions {
  /** Leave a byte-order mark at offset 0 alone, as the start of a file's first line. */
  ignoreLeadingBom?: boolean;
}

const BLACK_FLAG = 0x1f3f4;

// Names for the flagged characters a reader is most likely to meet; the rest fall back to
// their kind's generic name.
const CHARACTER_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, "soft hyphen"],
  [0x061c, "Arabic letter mark"],
  [0x115f, "Hangul choseong filler"],
  [0x1160, "Hangul jungseong filler"],
  [0x180e, "Mongolian vowel separator"],
  [0x200b, "zero width space"],
  [0x200c, "zero width non-joiner"],
  [0x200d, "zero width joiner"],
  [0x200e, "left-to-right mark"],
  [0x200f, "right-to-left mark"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x202a, "left-to-right embedding"],
  [0x202b, "right-to-left embedding"],
  [0x202c, "pop directional formatting"],
  [0x202d, "left-to-right override"],
  [0x202e, "right-to-left override"],
  [0x2060, "word joiner"],
  [0x2066, "left-to-right isolate"],
  [0x2067, "right-to-left isolate"],
  [0x2068, "first strong isolate"],
  [0x2069, "pop directional isolate"],
  [0x3164, "Hangul filler"],
  [0xfeff, "zero width no-break space"],
  [0xffa0, "halfwidth Hangul filler"],
]);

// Every candidate code point, for a fast "anything to do?" test before the per-character
// walk. Kept in step with `reviewHiddenCharacterKind`, which the unit tests assert. Not a
// global regex, so `test` keeps no state between calls.
const CANDIDATE =
  /[\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|\u{E0001}|[\u{E0020}-\u{E007F}]/u;

/** Classify one code point by itself, before any context rule; `undefined` when ordinary. */
export function reviewHiddenCharacterKind(
  codePoint: number,
): ReviewHiddenCharacterKind | undefined {
  if (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  ) {
    return "bidi";
  }
  if (
    codePoint === 0x00ad ||
    codePoint === 0x115f ||
    codePoint === 0x1160 ||
    codePoint === 0x17b4 ||
    codePoint === 0x17b5 ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x206a && codePoint <= 0x206f) ||
    codePoint === 0x3164 ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    codePoint === 0xe0001 ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  ) {
    return "invisible";
  }
  return undefined;
}

/** Return whether text may contain a flagged character; a cheap pre-check for hot paths. */
export function mayContainReviewHiddenCharacters(text: string) {
  return CANDIDATE.test(text);
}

/** The code point that ends just before `index`, reading a surrogate pair whole. */
function codePointBefore(text: string, index: number) {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

/** Whether one neighbor of a joiner is a visible non-ASCII character it may shape. */
function isJoinableNeighbor(codePoint: number | undefined) {
  if (codePoint === undefined || codePoint <= 0x7f) return false;
  if (reviewHiddenCharacterKind(codePoint) !== undefined) return false;
  return !/\s/u.test(String.fromCodePoint(codePoint));
}

/** Whether one code point is a tag character (U+E0001, U+E0020–E007F). */
function isTagCharacter(codePoint: number) {
  return codePoint === 0xe0001 || (codePoint >= 0xe0020 && codePoint <= 0xe007f);
}

/**
 * Whether a zero-width joiner or non-joiner at `index` shapes legitimate text and stays silent:
 * between two non-ASCII characters it joins emoji sequences and Persian or Indic words. Attacks
 * hide joiners inside ASCII identifiers and paths, which stay flagged.
 */
function isLegitimateJoiner(text: string, index: number, length: number) {
  return (
    isJoinableNeighbor(codePointBefore(text, index)) &&
    isJoinableNeighbor(text.codePointAt(index + length))
  );
}

/**
 * Every flagged character in one text, in order.
 *
 * One forward pass, linear in the text: a run of tag characters is judged once, by the code
 * point before its first tag (a black flag spells a subdivision flag), rather than by walking
 * back over the run from every tag in it.
 */
export function findReviewHiddenCharacters(
  text: string,
  options: ReviewHiddenTextOptions = {},
): ReviewHiddenCharacter[] {
  if (!CANDIDATE.test(text)) return [];
  const found: ReviewHiddenCharacter[] = [];
  // Whether the tag run in progress follows a black flag; `undefined` outside a run.
  let tagRunAfterFlag: boolean | undefined;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const length = codePoint > 0xffff ? 2 : 1;
    const kind = reviewHiddenCharacterKind(codePoint);
    if (isTagCharacter(codePoint)) {
      tagRunAfterFlag ??= codePointBefore(text, index) === BLACK_FLAG;
    } else {
      tagRunAfterFlag = undefined;
    }
    const exempt =
      kind === undefined ||
      (codePoint === 0xfeff && index === 0 && options.ignoreLeadingBom === true) ||
      ((codePoint === 0x200c || codePoint === 0x200d) && isLegitimateJoiner(text, index, length)) ||
      tagRunAfterFlag === true;
    if (!exempt) found.push({ index, length, codePoint, kind });
    index += length;
  }
  return found;
}

/** Split one text into ordinary runs and single flagged characters, in order. */
export function splitReviewHiddenText(
  text: string,
  options: ReviewHiddenTextOptions = {},
): ReviewHiddenTextSegment[] {
  const hidden = findReviewHiddenCharacters(text, options);
  if (hidden.length === 0) return text.length > 0 ? [{ text }] : [];
  const segments: ReviewHiddenTextSegment[] = [];
  let cursor = 0;
  for (const character of hidden) {
    if (character.index > cursor) segments.push({ text: text.slice(cursor, character.index) });
    segments.push({
      text: text.slice(character.index, character.index + character.length),
      hidden: character,
    });
    cursor = character.index + character.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** One code point in Unicode's notation: `U+202E`, `U+E0041`. */
export function formatReviewHiddenCharacter(codePoint: number) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A reader-facing name for one flagged character: "right-to-left override (U+202E)". */
export function describeReviewHiddenCharacter(
  character: Pick<ReviewHiddenCharacter, "codePoint" | "kind">,
) {
  const name =
    CHARACTER_NAMES.get(character.codePoint) ??
    (character.codePoint >= 0xe0000
      ? "tag character"
      : character.kind === "bidi"
        ? "bidirectional control"
        : "invisible character");
  return `${name} (${formatReviewHiddenCharacter(character.codePoint)})`;
}

/**
 * Replace every flagged character with a visible `<U+202E>` marker, for plain-text sinks
 * (tooltips, accessible names, toasts, tree paths) that cannot style a marker.
 */
export function revealReviewHiddenText(text: string, options: ReviewHiddenTextOptions = {}) {
  const hidden = findReviewHiddenCharacters(text, options);
  if (hidden.length === 0) return text;
  let revealed = "";
  let cursor = 0;
  for (const character of hidden) {
    revealed += `${text.slice(cursor, character.index)}<${formatReviewHiddenCharacter(character.codePoint)}>`;
    cursor = character.index + character.length;
  }
  return revealed + text.slice(cursor);
}

/** Fold the kinds flagged in one text into running facts. */
function collectHiddenText(
  facts: ReviewHiddenTextFacts,
  text: string,
  options: ReviewHiddenTextOptions = {},
) {
  if (!CANDIDATE.test(text)) return;
  for (const character of findReviewHiddenCharacters(text, options)) {
    facts[character.kind] = true;
    if (facts.bidi && facts.invisible) return;
  }
}

/**
 * Which kinds of flagged characters one file's paths and diff lines contain, or `undefined`
 * when it has none. A byte-order mark that opens a line is the start of a file and is not
 * counted; one inside a line is.
 */
export function reviewFileHiddenText(
  file: Pick<ReviewFile, "path" | "previousPath" | "additionLines" | "deletionLines">,
): ReviewHiddenTextFacts | undefined {
  const facts: ReviewHiddenTextFacts = { bidi: false, invisible: false };
  collectHiddenText(facts, file.path);
  if (file.previousPath !== undefined) collectHiddenText(facts, file.previousPath);
  for (const lines of [file.additionLines, file.deletionLines]) {
    for (const line of lines) {
      collectHiddenText(facts, line, { ignoreLeadingBom: true });
      if (facts.bidi && facts.invisible) return facts;
    }
  }
  return facts.bidi || facts.invisible ? facts : undefined;
}
