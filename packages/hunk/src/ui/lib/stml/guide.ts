// The STML authoring guide printed by `hunk markup guide`.
//
// This is the canonical teaching artifact for agents writing markup notes.
// It is loaded on demand (never embedded in a prompt), but agents pay its
// token cost each time they read it, so it stays terse: the copy-paste
// snippets carry the teaching and prose is kept to what a snippet can't say.
// guide.test.ts lays out every ```stml fence at the reference width, so the
// guide can never drift from what the renderer accepts.

import { STML_REFERENCE_WIDTH } from "./layout";

export const STML_GUIDE = `# STML — terminal markup for Hunk agent notes

Experimental: the tag and color vocabulary may change between releases.
The review must be launched with \`--experimental\`; otherwise Hunk uses the
required plain-text summary fallback and rejects live markup comments.

Small HTML-like markup rendered as real terminal UI inside agent notes:
boxes, rows, badges, gauges, lists, code blocks. Sources (--summary stays
as the plain-text fallback):

    hunk session comment add ... --markup '<text>formatted note body</text>'
    comment apply items:    { "markup": "...", ... }
    agent-context sidecar:  annotations[].markup

Preview from a file or stdin:

    echo '<badge color="success">OK</badge> ready' | hunk markup render -

## Ground rules

- Hunk supplies the note's outer frame, author, and source location. STML is
  the note body; use borders for useful inner hierarchy rather than duplicating
  that frame around the whole body. Sibling and nested boxes are supported.
- Confirm \`hunk session context --json\` lists \`stml\` in
  \`experimentalFeatures\` before authoring markup. Width follows the live
  session: stack ≈ full pane, split ≈ half. The context reports
  \`noteMarkupWidth\`; comment responses echo \`markupWidth\`. Preview with
  \`hunk markup render - --width <that>\`. Unknown? Design for ~${STML_REFERENCE_WIDTH} cols —
  it holds up wider, and users resize/switch layouts anytime.
- No chart tag: gauges are block chars (█ ░) in color spans (glyph-run example below).
- Bad markup degrades instead of crashing and produces render notes
  (in comment responses and on \`markup render\` stderr) — fix what they flag.
- Entities work: &rarr; → &check; ✓ &amp; &.

## Tags

Block: box card section col row · text p · h1 h2 h3 · list ul ol item ·
hr · spacer · code pre
Inline: b i u s dim · c/color · kbd · badge · a · br
box/card attrs: border, border-style (single|rounded|double|heavy),
border-color, title, title-color, bg, padding[-x|-y], width (cells or %).
row: gap. list: marker. spacer: size. code: title.
Colors: theme tokens accent success warning danger info muted subtle heading
(preferred — they follow the user's theme), ANSI names, or #hex.

## Syntax examples

These fragments demonstrate mechanics, not preferred layouts. STML is an
open composition grammar: combine, omit, repeat, and nest elements as the
explanation requires.

Inline styles:

\`\`\`stml
<text><badge color="success">label</badge> <b>bold</b> <i>italic</i> <dim>dim</dim></text>
\`\`\`

Bordered grouping:

\`\`\`stml
<box border border-color="accent" padding-x="1" title="group">
  grouped detail
</box>
\`\`\`

Responsive siblings:

\`\`\`stml
<row gap="2">
  <box border title="left">first region</box>
  <box border title="right">second region</box>
</row>
\`\`\`

Colored glyph runs:

\`\`\`stml
<text><c fg="success">████████████</c><c fg="subtle">░░░░░░░░</c> 60%</text>
\`\`\`

Rows with connectors (the <br/> vertically centers each arrow):

\`\`\`stml
<row gap="1">
  <box border>first<br/><dim>detail</dim></box>
  <text width="3"><br/> &rarr;</text>
  <box border>second<br/><dim>detail</dim></box>
</row>
\`\`\`

List structure:

\`\`\`stml
<list>
  <item>first item</item>
  <item>second item</item>
</list>
\`\`\`

Fixed-width columns:

\`\`\`stml
<row gap="1">
  <box width="12"><dim>label</dim><br/><dim>status</dim></box>
  <box>value<br/>ready</box>
</row>
\`\`\`

Verbatim block (clips, never wraps):

\`\`\`stml
<code title="output">
const value = compute();
</code>
\`\`\`

Keyboard token:

\`\`\`stml
<text><kbd> key </kbd></text>
\`\`\`

Use STML when its layout makes the note clearer than plain text, and add
structure where it helps communicate the note.
`;

/** Extract the fenced \`\`\`stml snippets from the guide, in order. */
export function stmlGuideSnippets(guide: string = STML_GUIDE): string[] {
  const snippets: string[] = [];
  const fence = /```stml\n([\s\S]*?)```/g;
  for (let match = fence.exec(guide); match; match = fence.exec(guide)) {
    snippets.push(match[1]!.trimEnd());
  }
  return snippets;
}
