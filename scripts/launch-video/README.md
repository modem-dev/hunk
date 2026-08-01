# beta launch video pipeline

Generates the launch video from real Hunk sessions — no screen recording.
Every terminal frame is the live TUI driven headlessly over a PTY.

## How it works

1. **`capture.ts`** (Bun) — drives Hunk through the storyboard scenes with
   [tuistory](https://www.npmjs.com/package/tuistory) (the same PTY harness the
   integration tests use) and renders styled keyframes to PNG via
   ghostty-opentui's terminal image renderer. Scenes: STML agent notes
   (`examples/9-agent-markup-notes`), the `hunk markup render` CLI, the
   review-triage sidebar extension, and the JSX file-view gallery.
2. **`stage.html` + `compose.mjs`** (Node + playwright-core) — composites each
   keyframe into a 1920×1080 stage (window chrome, gradient backdrop, animated
   captions) and screenshots the timeline into unique frames plus an ffmpeg
   concat list with per-frame durations.
3. **ffmpeg** — encodes the concat list at 30fps.

## Regenerating

```sh
# 1. capture keyframes (writes .video-work/)
bun run scripts/launch-video/capture.ts

# 2. compositor deps: playwright-core matching the installed Chromium build
printf '{"name":"hunk-video-work","private":true}\n' > .video-work/package.json
cd .video-work && bun add playwright-core@1.56.1 && cd ..

# 3. composite the timeline (set the executablePath in compose.mjs if your
#    Chromium lives somewhere other than /opt/pw-browsers/chromium)
node scripts/launch-video/compose.mjs .video-work

# 4. encode
cd .video-work
ffmpeg -y -f concat -safe 0 -i concat.txt -vf "fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -movflags +faststart hunk-beta-launch.mp4
```

Storyboard, captions, and pacing all live in the `SHOTS` table in
`compose.mjs`; scene interactions live in `capture.ts`.
