# launch video pipeline

Generates hunk release videos from real Hunk sessions — no screen recording.
tuistory drives the TUI over a PTY (`capture.ts`), a Chromium-composited stage
adds window chrome and captions (`stage.html` + `compose.mjs`), and ffmpeg
encodes the result.

The full procedure — regeneration steps, environment gotchas, scene authoring,
storyboard model, and content-accuracy rules — lives in
[`skills/launch-video/SKILL.md`](../../skills/launch-video/SKILL.md).
