// The STML authoring guide printed by `hunk markup guide`.
//
// This is the canonical teaching artifact for agents writing markup notes, so
// it optimizes for copy-paste: every pattern is a complete, working snippet
// inside a ```stml fence. guide.test.ts extracts each fenced snippet and lays
// it out at the reference width, so the guide can never drift from what the
// renderer actually accepts.

import { STML_REFERENCE_WIDTH } from "./layout";

export const STML_GUIDE = `# STML — terminal markup for Hunk agent notes

STML is a small HTML-like markup rendered as real terminal UI inside Hunk's
inline note cards: bordered boxes, rows of shapes, lists, badges, gauges, and
code blocks instead of plain text.

Where markup goes (the plain --summary stays as the fallback text):

    hunk session comment add ... --markup '<box border>...</box>'
    comment apply batch items:   { "markup": "<box border>...</box>", ... }
    agent-context sidecar:       annotations[].markup

Preview before you publish (reads a file or stdin):

    echo '<badge color="success">OK</badge> ready' | hunk markup render -

## Ground rules

- Design for ~${STML_REFERENCE_WIDTH} columns. Notes are ~terminal-width in stack
  layout but docked to roughly half the pane in split layout; text wraps and
  code clips to fit. Preview at --width ${STML_REFERENCE_WIDTH} to match the tightest common case.
- There is no chart tag. Gauges and bars are block characters (█ ░) inside
  color spans — see the gauge pattern below.
- Unknown tags and bad colors never crash: they degrade and produce render
  notes. \`comment add\`/\`apply\` return those notes, and \`markup render\`
  prints them to stderr — treat any note as a prompt to fix your markup.
- Entities work in text: &rarr; renders →, &check; renders ✓, &amp; renders &.

## Tags

Block: box card section col row · text p · h1 h2 h3 · list ul ol item ·
hr · spacer · code pre
Inline: b i u s dim · c/color · kbd · badge · a · br

Attributes on box/card: border, border-style (single|rounded|double|heavy),
border-color, title, title-color, bg, padding / padding-x / padding-y,
width (cells or %). row: gap. list: marker. spacer: size. code: title.

Colors (fg=/bg=/color=/border-color=): semantic tokens accent, success,
warning, danger, info, muted, subtle, heading — these follow the user's Hunk
theme, so prefer them. ANSI-ish names (red, green, orange, …) and #hex also
work.

## Patterns

### Status line — verdict up front

\`\`\`stml
<text><badge color="success">PASS</badge> 34 tests · <badge color="warning">TODO</badge> add jitter · <dim>reviewed by fable</dim></text>
\`\`\`

### Titled card — one framed takeaway

\`\`\`stml
<card title="Why this is safe" border-color="success">
  Retries are capped at <b>3 attempts</b>; the last error is rethrown, so
  callers see the same failure mode as before.
</card>
\`\`\`

### Scorecard — a row of titled boxes

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

### Gauges — block characters in color spans

Pick a fixed bar budget (~20 cells), split it filled/empty, label the end.

\`\`\`stml
<text>coverage <c fg="success">████████████████</c><c fg="subtle">░░░░</c> 80%</text>
<text>p95      <c fg="accent">███████</c><c fg="subtle">░░░░░░░░░░░░░</c> 340ms</text>
<text>risk     <c fg="danger">████</c><c fg="subtle">░░░░░░░░░░░░░░░░</c> low</text>
\`\`\`

### Pipeline — boxes joined by arrow columns

The <br/> pushes each arrow down one row so it aligns with the box body.

\`\`\`stml
<row gap="1">
  <box border border-color="accent" padding-x="1">parse</box>
  <text width="3"><br/> &rarr;</text>
  <box border border-color="info" padding-x="1">layout</box>
  <text width="3"><br/> &rarr;</text>
  <box border border-color="success" padding-x="1">render</box>
</row>
\`\`\`

### Checklist — badges as row markers

\`\`\`stml
<list>
  <item><badge color="success">DONE</badge> bounded retry loop</item>
  <item><badge color="warning">TODO</badge> add <i>jitter</i> to the backoff</item>
  <item><badge color="danger">RISK</badge> <b>delayMs</b> grows unbounded</item>
</list>
\`\`\`

### Key-value block — fixed label column

\`\`\`stml
<row gap="1">
  <box width="12"><dim>attempts</dim><br/><dim>base delay</dim><br/><dim>growth</dim></box>
  <box>3 max<br/>100ms<br/>×2 per attempt</box>
</row>
\`\`\`

### Code suggestion — verbatim, clipped, framed

\`\`\`stml
<text>Consider extracting the policy:</text>
<code title="suggestion">
const backoff = (attempt: number) =>
  100 * 2 ** (attempt - 1);
</code>
\`\`\`

### Keyboard hints

\`\`\`stml
<text>press <kbd> a </kbd> to toggle notes, <kbd> [ </kbd> <kbd> ] </kbd> to jump hunks</text>
\`\`\`

## Taste

- Lead with the verdict (badge or heading), then evidence. Reviewers scan.
- One idea per note; two or three blocks max. A note is a callout, not a page.
- Use semantic color tokens for meaning, not decoration — danger means danger.
- Keep --summary a real sentence: it is what note lists and fallbacks show.
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
