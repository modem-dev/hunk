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
[`skills/launch-video/SKILL.md`](../../skills/launch-video/SKILL.md).
