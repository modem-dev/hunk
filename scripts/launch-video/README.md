# launch video pipeline

Generates hunk release videos from real Hunk sessions — no screen recording.
This directory holds only the per-release storyboard: the capture scenes
(`capture.ts`) and the shot list, cards, and captions (`compose.mjs`). The
generic machinery — PTY driving, keyframe rendering, storyboard planning,
Chromium compositing, the stage template — is the `@hunk/term-video` package
in `packages/term-video/`.

The full procedure — regeneration steps, environment gotchas, scene authoring,
storyboard model, and content-accuracy rules — lives in
[`skills/launch-video/SKILL.md`](../../skills/launch-video/SKILL.md).
