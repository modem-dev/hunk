# @hunk/term-video

Keyframe-based terminal product videos. Instead of screen-recording in real
time, a script drives the real TUI over a PTY and snaps discrete styled
keyframes; a storyboard then declares how long each state holds and which
caption accompanies it; Chromium composites each frame onto a stage (window
chrome, captions, title cards); ffmpeg encodes the result. Pacing is
deterministic, a minute of video is ~300 unique frames, and every frame is an
inspectable PNG before anything is encoded.

## Entry points

- `@hunk/term-video/capture` (Bun) — PTY driving and keyframe snapping:
  `createKeyframer`, `launchApp`, `launchShell`, `createCommandWrapper`,
  `typeCommand`, `ensureKeyboardIsLive`, `makeSceneFilter`.
- `@hunk/term-video/plan` (Bun or Node) — pure storyboard→frame-plan
  expansion: `planFrames`, `requiredKeyframes`. Unit-tested; owns the caption
  carry-forward and animation-window semantics.
- `@hunk/term-video/compose` (Node ≥ 18) — `composeStoryboard` renders the
  plan in headless Chromium against `src/stage.html` (or a custom stage) and
  writes PNG frames plus an ffmpeg concat list. `playwright-core` is resolved
  from the caller's work directory so its version can match the driven
  Chromium build.

## Consumers

`scripts/launch-video/` holds Hunk's current storyboard (scenes, captions,
cards) on top of this package; `skills/launch-video/SKILL.md` documents the
end-to-end workflow and recipes for single-feature, custom, and full-release
videos, environment gotchas included.
