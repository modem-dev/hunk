# Hunk video pipeline

Generates Hunk product videos from real Hunk sessions — no screen recording.
The same pipeline supports single-feature demos, workflow explainers, launch
videos, and full-release roundups. This directory holds only the current Hunk
storyboard: the capture scenes (`capture.ts`) and the shot list, cards, and
captions (`compose.mjs`). The generic machinery — PTY driving, keyframe
rendering, storyboard planning, Chromium compositing, and the stage template —
is the `@hunk/term-video` package in `packages/term-video/`.

The full procedure — regeneration steps, environment gotchas, scene authoring,
storyboard model, and content-accuracy rules — lives in
[`skills/hunk-launch-video/SKILL.md`](../../skills/hunk-launch-video/SKILL.md).

`promo/` is the house style for release videos: `engine.js` and
`stage.html` are the reusable style kit, `storyboards/<version>.mjs` holds one
release's content, `contributors.mjs` computes the credits from a tag range,
and `render.mjs` renders the cut through `@hunk/term-video/timeline`. The
full-release recipe in the skill walks through making the next one.
