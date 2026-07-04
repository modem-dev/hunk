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
Markup degrades to plain text, so worst case a note loses polish, not content.

Small HTML-like markup rendered as real terminal UI inside note cards:
boxes, rows, badges, gauges, lists, code blocks. Sources (--summary stays
as the plain-text fallback):

    hunk session comment add ... --markup '<box border>...</box>'
    comment apply items:    { "markup": "...", ... }
    agent-context sidecar:  annotations[].markup

Preview from a file or stdin:

    echo '<badge color="success">OK</badge> ready' | hunk markup render -

## Ground rules

- Width follows the live session: stack ≈ full pane, split ≈ half, big
  terminal = big note. \`hunk session context --json\` reports
  \`noteMarkupWidth\`; comment responses echo \`markupWidth\`. Preview with
  \`hunk markup render - --width <that>\`. Unknown? Design for ~${STML_REFERENCE_WIDTH} cols —
  it holds up wider, and users resize/switch layouts anytime.
- No chart tag: gauges are block chars (█ ░) in color spans (pattern below).
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

## Patterns

Status line:

\`\`\`stml
<text><badge color="success">PASS</badge> 34 tests · <badge color="warning">TODO</badge> add jitter · <dim>reviewed by fable</dim></text>
\`\`\`

Titled card:

\`\`\`stml
<card title="Why this is safe" border-color="success">
  Retries cap at <b>3 attempts</b>; the last error is rethrown.
</card>
\`\`\`

Scorecard row:

\`\`\`stml
<row gap="2">
  <box border border-color="success" padding-x="1" title="tests">
    <c fg="success">✓</c> 34 pass
  </box>
  <box border border-color="warning" padding-x="1" title="risks">
    <badge color="danger">RISK</badge> unbounded delay
  </box>
</row>
\`\`\`

Gauges (fixed bar budget ~20 cells, filled/empty split, label at the end):

\`\`\`stml
<text>coverage <c fg="success">████████████████</c><c fg="subtle">░░░░</c> 80%</text>
<text>p95      <c fg="accent">███████</c><c fg="subtle">░░░░░░░░░░░░░</c> 340ms</text>
\`\`\`

Pipeline (the <br/> drops each arrow to the boxes' middle row):

\`\`\`stml
<row gap="1">
  <box border border-color="accent" padding-x="1">parse</box>
  <text width="3"><br/> &rarr;</text>
  <box border border-color="success" padding-x="1">render</box>
</row>
\`\`\`

Checklist:

\`\`\`stml
<list>
  <item><badge color="success">DONE</badge> bounded retry loop</item>
  <item><badge color="warning">TODO</badge> add <i>jitter</i></item>
  <item><badge color="danger">RISK</badge> <b>delayMs</b> grows unbounded</item>
</list>
\`\`\`

Key-value block:

\`\`\`stml
<row gap="1">
  <box width="12"><dim>attempts</dim><br/><dim>base delay</dim></box>
  <box>3 max<br/>100ms</box>
</row>
\`\`\`

Code suggestion (verbatim; clips, never wraps):

\`\`\`stml
<code title="suggestion">
const backoff = (attempt: number) =>
  100 * 2 ** (attempt - 1);
</code>
\`\`\`

Keyboard hints:

\`\`\`stml
<text>press <kbd> a </kbd> to toggle notes</text>
\`\`\`

A note reads best as a callout, not a page: verdict first, a couple of
blocks of evidence, semantic colors used for meaning.
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
