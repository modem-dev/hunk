/** @jsxImportSource react */
/**
 * Draws repository-controlled text so hidden characters show and cannot reorder the page.
 *
 * Paths, note bodies and authors, Markdown, toasts, and diff lines all come from the reviewed
 * repository or from an agent, so a bidi override in them would let a browser reorder what the
 * reader sees (`file<U+202E>txt.exe` drawn as `fileexe.txt`), and a zero-width character would
 * hide. Which characters count is decided once, in `core/review/hiddenText.ts`; this module only
 * draws them.
 *
 * Each flagged character becomes a marker: an atomic inline-block that keeps the real character
 * (zero-sized) and shows its code point (`U+202E`) from CSS generated content. Being atomic, its
 * content cannot reorder anything around it, and because generated content is never copied, a
 * copied selection still carries the exact characters the file holds; assistive technology
 * hears the code point, not the raw control, which is hidden from it. Every piece of text is
 * also bidi-isolated, so legitimate right-to-left names keep their own order without pulling
 * neighboring chrome into it. Plain-text sinks — tooltips, accessible names, tree paths — use
 * `revealReviewHiddenText` instead, which spells the marker as `<U+202E>`.
 *
 * Two entry points share one marker shape: `RevealedText` for React, and
 * `revealHiddenCharactersIn` for plain DOM — text Pierre already drew, and the note cards.
 */
import {
  describeReviewHiddenCharacter,
  findReviewHiddenCharacters,
  formatReviewHiddenCharacter,
  mayContainReviewHiddenCharacters,
  splitReviewHiddenText,
  type ReviewHiddenCharacter,
  type ReviewHiddenTextOptions,
} from "../../core/review/hiddenText";

/** The class on every hidden-character marker. */
const HIDDEN_CHARACTER_CLASS = "hidden-char";

/** The class on the zero-sized element inside a marker that holds the real character. */
const HIDDEN_CHARACTER_SOURCE_CLASS = "hidden-char-source";

/** The class on a run of isolated repository text. */
const REVEALED_TEXT_CLASS = "revealed-text";

/**
 * Marker rules for shadow roots the page stylesheet cannot reach (Pierre's code view). The
 * page stylesheet carries the same rules for its own DOM.
 */
export const HIDDEN_CHARACTER_SHADOW_CSS = `
.${HIDDEN_CHARACTER_CLASS} {
  display: inline-block;
  unicode-bidi: isolate;
  direction: ltr;
  white-space: nowrap;
}
.${HIDDEN_CHARACTER_CLASS}::before {
  content: attr(data-label);
  display: inline-block;
  margin: 0 1px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 0.8em;
  line-height: 1.3;
  font-family: var(--code-font, ui-monospace, monospace);
  font-style: normal;
  font-weight: normal;
  color: var(--hunk-text);
  background: color-mix(in srgb, var(--hunk-file-modified) 22%, transparent);
  box-shadow: inset 0 0 0 1px var(--hunk-file-modified);
}
.${HIDDEN_CHARACTER_CLASS} > .${HIDDEN_CHARACTER_SOURCE_CLASS} {
  display: inline-block;
  width: 0;
  height: 0;
  overflow: hidden;
  font-size: 0;
}
`;

/** Attributes every marker carries, whichever renderer draws it. */
function markerAttributes(character: ReviewHiddenCharacter) {
  return {
    label: formatReviewHiddenCharacter(character.codePoint),
    title: describeReviewHiddenCharacter(character),
  };
}

/** One visible marker around one flagged character, in React. */
function HiddenCharacterMark({
  text,
  character,
}: {
  text: string;
  character: ReviewHiddenCharacter;
}) {
  const { label, title } = markerAttributes(character);
  return (
    <span
      className={HIDDEN_CHARACTER_CLASS}
      data-kind={character.kind}
      data-label={label}
      title={title}
    >
      <span className={HIDDEN_CHARACTER_SOURCE_CLASS} aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/**
 * Repository text with every hidden character drawn as a marker, bidi-isolated as one span.
 *
 * Pass `isolate={false}` for prose that flows with its neighbors (Markdown inlines, code
 * blocks): isolating each run of a right-to-left paragraph separately would reorder it.
 */
export function RevealedText({ text, isolate = true }: { text: string; isolate?: boolean }) {
  const content = mayContainReviewHiddenCharacters(text)
    ? splitReviewHiddenText(text).map((segment, index) =>
        segment.hidden ? (
          <HiddenCharacterMark key={index} text={segment.text} character={segment.hidden} />
        ) : (
          segment.text
        ),
      )
    : text;
  return isolate ? <span className={REVEALED_TEXT_CLASS}>{content}</span> : <>{content}</>;
}

/** One marker element around the real character, built in `document`. */
function markerElement(document: Document, source: Node, character: ReviewHiddenCharacter) {
  const { label, title } = markerAttributes(character);
  const marker = document.createElement("span");
  marker.className = HIDDEN_CHARACTER_CLASS;
  marker.dataset.kind = character.kind;
  marker.dataset.label = label;
  marker.title = title;
  const holder = document.createElement("span");
  holder.className = HIDDEN_CHARACTER_SOURCE_CLASS;
  holder.setAttribute("aria-hidden", "true");
  holder.append(source);
  marker.append(holder);
  return marker;
}

/** Text nodes under one element, in order. */
function textNodesOf(element: Element) {
  const nodes: Text[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** Wrap the flagged characters of one unit of text (a drawn line, a paragraph) in markers. */
function revealUnit(unit: Element, options: ReviewHiddenTextOptions) {
  const nodes = textNodesOf(unit);
  const text = nodes.map((node) => node.data).join("");
  const hits: { node: Text; offset: number; character: ReviewHiddenCharacter }[] = [];
  let start = 0;
  let nodeIndex = 0;
  for (const character of findReviewHiddenCharacters(text, options)) {
    while (start + nodes[nodeIndex]!.data.length <= character.index) {
      start += nodes[nodeIndex]!.data.length;
      nodeIndex += 1;
    }
    const node = nodes[nodeIndex]!;
    // A character marked by an earlier pass is already inside its marker.
    if (node.parentElement?.classList.contains(HIDDEN_CHARACTER_SOURCE_CLASS)) continue;
    hits.push({ node, offset: character.index - start, character });
  }
  // Last first, so splitting a node never moves an offset still to be visited in it.
  for (const { node, offset, character } of hits.reverse()) {
    node.splitText(offset + character.length);
    const source = node.splitText(offset);
    const parent = source.parentNode!;
    const next = source.nextSibling;
    // The marker takes the real character node itself, then sits where it was.
    parent.insertBefore(markerElement(unit.ownerDocument, source, character), next);
  }
}

/**
 * Mark every hidden character in text another renderer already drew under `root`.
 *
 * Text is scanned per unit — the nearest ancestor matching `unitSelector`, else the text's
 * parent element — so a joiner's neighbors are read across token spans. Safe to repeat after
 * every redraw: characters already inside a marker are left alone, and a root with nothing to
 * flag costs one cheap test per text node.
 */
export function revealHiddenCharactersIn(
  root: Node,
  { unitSelector, ...options }: ReviewHiddenTextOptions & { unitSelector?: string } = {},
) {
  const document = root.ownerDocument ?? (root as Document);
  const units = new Set<Element>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !mayContainReviewHiddenCharacters((node as Text).data)) continue;
    if (parent.classList.contains(HIDDEN_CHARACTER_SOURCE_CLASS)) continue;
    units.add((unitSelector ? parent.closest(unitSelector) : null) ?? parent);
  }
  for (const unit of units) revealUnit(unit, options);
}
