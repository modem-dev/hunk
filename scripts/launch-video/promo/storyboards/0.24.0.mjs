// The 0.24.0 social cut: the release content the promo engine renders.
//
// Copy this file for the next release and replace the content; the style
// lives in ../engine.js. Chapter frames name keyframes captured by
// scripts/launch-video/capture.ts (SCENES=open,conflict,layout,scrolloff,completion).
// Chapter times (cameras, captions, highlights, labels) are seconds from the
// start of the chapter's terminal scene; camera/highlight coordinates are
// fractions of the captured frame.

/** One keyframe per keypress, all sharing a key and a hold time. */
function steps(prefix, from, to, { key, dur, lastDur, pad = 0 }) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    img: `${prefix}${String(from + i).padStart(pad, "0")}`,
    dur: from + i === to ? lastDur : dur,
    key,
  }));
}

export default {
  version: "0.24",
  hook: { sub: "every frame below is the real terminal UI" },

  // Ordered by impact: the biggest new capability first.
  chapters: [
    {
      label: "hunk open",
      title: ["Open", "*anything."],
      sub: "Whole files. Whole folders. Syntax-highlighted.",
      cmd: "hunk open",
      winTitle: "hunk open — taskboard",
      frames: [
        { img: "open-overview", dur: 0.95 },
        { img: "open-tree-0", dur: 0.28, key: "J" },
        { img: "open-tree-1", dur: 0.5, key: "Enter" },
        ...steps("open-tree-", 2, 5, { key: "J", dur: 0.22, lastDur: 0.6 }),
        { img: "open-document", dur: 1.6, key: "Enter" },
        ...steps("open-scroll-", 0, 5, { key: "PgDn", dur: 0.32, lastDur: 1.1 }),
      ],
      cameras: [
        [0, { x: 0.5, y: 0.5, scale: 1 }],
        [0.9, { x: 0, y: 0, scale: 1.6 }, 0.6],
        [3.3, { x: 0.62, y: 0.42, scale: 1.3 }, 0.7],
      ],
      captions: [
        [0.5, "browse any folder"],
        [1.6, "a <b>Git-aware</b> file tree"],
        [3.3, "the <b>complete</b> file, highlighted"],
        [5.1, "scroll it like a review"],
      ],
    },
    {
      label: "conflict diffs",
      title: ["Merge", "*conflicts,", "reviewed."],
      sub: "Paused merge or rebase? See every conflict in context.",
      cmd: "hunk diff",
      winTitle: "hunk diff — merge in progress",
      frames: [{ img: "conflict-review", dur: 4.6 }],
      cameras: [
        [0, { x: 0.5, y: 0.5, scale: 1 }],
        [1.3, { x: 0.3, y: 0.78, scale: 1.55 }, 0.9],
      ],
      highlights: [{ t0: 2.2, t1: 9, x: 0.008, y: 0.6875, w: 0.6, h: 0.156 }],
      labels: [
        { t0: 2.6, t1: 9, x: 0.5, y: 0.734, text: "ours · HEAD" },
        { t0: 2.9, t1: 9, x: 0.5, y: 0.796, text: "theirs · glyph-markers" },
      ],
      captions: [
        [0.5, "mid-merge? the conflicts <b>are</b> the review"],
        [2.2, "both sides, right in context"],
      ],
    },
    {
      label: "auto layout",
      title: ["Split", "or *unified?", "Automatic."],
      sub: "Layout now adapts as panes open and close.",
      cmd: "auto_split_min_width",
      winTitle: "hunk diff — auto layout",
      frames: [
        { img: "layout-split", dur: 1.7 },
        { img: "layout-unified", dur: 1.9, key: "S", fade: 0.18 },
        { img: "layout-split-again", dur: 1.4, key: "S", fade: 0.18 },
      ],
      cameras: [[0, { x: 0.5, y: 0.5, scale: 1 }]],
      highlights: [{ t0: 2.0, t1: 3.6, x: 0.004, y: 0.068, w: 0.162, h: 0.256 }],
      captions: [
        [0.5, "room to spare: <b>split</b>"],
        [1.7, "open the files pane: <b>unified</b>"],
        [3.6, "close it: back to split"],
      ],
    },
    {
      label: "scroll_off",
      title: ["Never", "hug the", "*edge."],
      sub: "Five rows of context stay ahead of the cursor.",
      cmd: "scroll_off = 5",
      winTitle: "hunk diff — taskboard",
      frames: [
        ...steps("scrolloff-step-", 10, 19, { key: "J", dur: 0.15, lastDur: 0.15, pad: 2 }),
        ...steps("scrolloff-step-", 20, 33, { key: "J", dur: 0.19, lastDur: 1.0, pad: 2 }),
      ],
      cameras: [
        [0, { x: 0.5, y: 0.5, scale: 1 }],
        [0.6, { x: 0, y: 1, scale: 1.35 }, 0.7],
      ],
      highlights: [{ t0: 1.6, t1: 9, x: 0.004, y: 0.812, w: 0.735, h: 0.158 }],
      labels: [{ t0: 1.8, t1: 9, x: 0.6, y: 0.79, text: "5 rows ahead" }],
      captions: [
        [0.4, "step with <b>j</b>"],
        [1.6, "the view scrolls <b>early</b>"],
      ],
    },
    {
      label: "completions",
      title: ["Tab.", "Tab.", "*Done."],
      sub: "Shell completions for bash and zsh.",
      cmd: "source <(hunk completion bash)",
      winTitle: "shell — taskboard",
      frames: [
        { img: "completion-typed", dur: 0.8 },
        { img: "completion-commands", dur: 1.6, key: "Tab" },
        { img: "completion-mode-typed", dur: 0.7 },
        { img: "completion-modes", dur: 1.5, key: "Tab" },
      ],
      // Short shell output gets a compact window instead of a full screen.
      bodyH: 250,
      cameras: [[0, { x: 0, y: 0, scale: 1.27 }]],
      captions: [
        [0.4, "every command"],
        [2.4, "…and every flag value"],
      ],
    },
  ],

  montage: {
    items: [
      { big: "npm<br/>extensions", small: "hunk extension install @scope/pkg" },
      { big: "faster first<br/>keypress", small: "syntax highlighting runs in a worker" },
      { big: "leaner<br/>--watch", small: "long sessions no longer leak memory" },
      { big: "remappable<br/>note save", small: "hunk.review.saveNote" },
    ],
    // 51 patch entries in the 0.24.0 changelog.
    fixes: { count: 50, label: "fixes &amp; polish" },
  },

  // contributors.mjs credits everyone who authored or co-authored a commit in this range.
  contributors: {
    from: "v0.23.0",
    to: "v0.24.0",
    thanks: "shipped 0.24 together. thank you.",
    // Co-author trailers whose email GitHub cannot resolve to an account.
    aliases: { "shashank.telkhade@gmail.com": { login: "shashank-100", id: 22212089 } },
  },
};
