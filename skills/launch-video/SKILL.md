---
name: launch-video
description: Produces hunk launch/release videos by driving the real TUI headlessly in a PTY, compositing captioned 1080p frames in Chromium, and encoding with ffmpeg. Use when asked to create, update, or re-cut a release announcement, demo, or launch video for hunk.
---

# Launch video pipeline

Generates release videos where every terminal frame is the real Hunk TUI —
no screen recording, no mockups. Three stages, all in `scripts/launch-video/`:

```text
capture.ts   (bun)   drive Hunk over a PTY, snap styled keyframes to PNG
compose.mjs  (node)  composite keyframes onto a 1920x1080 stage, emit frames + concat list
ffmpeg               encode the concat list at 30fps to mp4/webm
```

## Recreating a video

```sh
# 1. capture keyframes into .video-work/ (must run from the repo root — see gotchas)
bun run scripts/launch-video/capture.ts

# 2. one-time compositor setup: playwright-core matching the installed Chromium
printf '{"name":"hunk-video-work","private":true}\n' > .video-work/package.json
cd .video-work && bun add playwright-core@<version> && cd ..   # see gotchas for <version>

# 3. composite the storyboard
node scripts/launch-video/compose.mjs .video-work

# 4. encode
cd .video-work
ffmpeg -y -f concat -safe 0 -i concat.txt -vf "fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -movflags +faststart launch.mp4
ffmpeg -y -f concat -safe 0 -i concat.txt -vf "fps=30,format=yuv420p" \
  -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 launch.webm
```

Iterate on one scene without re-capturing the rest:

```sh
SCENES=review bun run scripts/launch-video/capture.ts   # comma-separated scene names
```

Scene names are the `wants("...")` guards in `capture.ts`'s `main()`.

## Updating for a new release

1. Read the new release section in `CHANGELOG.md`; the **Highlights** list is
   the storyboard. Each user-visible highlight deserves a scene or caption.
2. Add/adjust scenes in `capture.ts` (see "Authoring scenes"), then rewrite the
   `SHOTS` table and cards in `compose.mjs` (see "Storyboard model").
3. Update the title-card badge to the release version and verify the install
   commands (see "Content accuracy").
4. Re-run the four steps above, verify (see "Verification"), and deliver both
   mp4 and webm.

## Environment gotchas (each cost real debugging time)

- **Run `capture.ts` with bun from the repo root.** tuistory uses subpath
  self-imports (`tuistory/pty`) that only resolve inside this repo's
  `node_modules`; running the script from elsewhere resolves tuistory from
  bun's global cache and crashes.
- **ghostty-opentui is a transitive dep** (via tuistory) with an exports map:
  import `"ghostty-opentui/image"` (not `.../dist/image.js`), resolved
  relative to tuistory — `capture.ts` shows the `Bun.resolveSync` dance.
- **playwright-core must match the preinstalled Chromium build.** Check
  `ls /opt/pw-browsers` (e.g. `chromium-1194` pairs with playwright-core
  1.56.x) and launch with `executablePath: "/opt/pw-browsers/chromium"`.
- **Give `.video-work/` its own `package.json` before `bun add`.** Without
  one, bun walks up and installs into the repo's `package.json` — revert with
  `git checkout package.json bun.lock` if that happens.
- **Chromium needs `--allow-file-access-from-files`**: the stage samples each
  keyframe through a canvas to color-match the window background, and file://
  images taint the canvas without it.
- **Use system ffmpeg (apt) for mp4.** Playwright's bundled
  `/opt/pw-browsers/ffmpeg-*/ffmpeg-linux` only encodes VP8/WebM. If apt
  fails with 404s, `apt-get update` first.
- **Caption font**: JetBrains Mono ships inside ghostty-opentui
  (`public/jetbrains-mono-nerd.ttf`); `compose.mjs` bakes it into the stage
  via `@font-face`, so no system font install is needed.

## Authoring scenes (capture.ts)

- Shared geometry is 140x32 cells rendered at fontSize 16 / dpr 2 → 2688x1536
  PNGs. Keep every scene at this size so all frames fit one window.
- Reusable helpers: `createDemoRepo()` (git repo built from
  `examples/2-mini-app-refactor` with the after-tree as the working diff),
  `createHunkPathWrapper()` + `launchShell()` (interactive bash with a real
  `hunk` command on PATH and a clean `❯` prompt), `typeCommand()` (per-char
  typing with mid-command snaps), `snap(session, name)` (styled PNG keyframe).
- Always `waitForText` on scene-specific content before the first snap, and
  call `ensureKeyboardIsLive()` before scripted keypresses — the first key
  after startup can be dropped (real race, the helper toggles `?` to prove
  keys land).
- **Animation = one snap per keypress.** The cursor walk and typing effects
  are just every `j`/`k`/character captured as its own frame and played back
  at 0.2–0.3s per frame. Prefer this over sparse keyframes: three stills read
  as a slideshow, per-press frames read as motion.
- `renderTerminalToImage` auto-trims trailing blank rows, so short outputs
  (CLI scenes) produce short PNGs — the stage handles this by sampling the
  image's bottom-left pixel and painting the window body to match.
- Demo content that must exist: STML notes come from
  `examples/9-agent-markup-notes` (launch with `--experimental`), extension
  scenes from `examples/extensions/` loaded via `--extension <path>` (explicit
  paths skip the repo trust prompt). The pager pipe is `git diff | hunk pager`
  — bare `hunk` on piped stdin prints help. Sidebar toggle is `s`; comment
  draft is `c`, save with Ctrl+S (`\x13`).

## Storyboard model (compose.mjs)

- `SHOTS` is the whole edit: one entry per shot, `dur` in seconds, played as
  unique frames + per-frame durations in an ffmpeg concat list (holds cost one
  frame, so runtime is dominated by transitions, not length).
- `capKey` is caption identity: the caption slides in only when `capKey`
  changes, and continuation shots that share a `capKey` without restating
  `caption` keep the previous caption on screen. Sequences (walks, typing) are
  generated with `Array.from` spreads.
- `enter: true` fades/scales the surface in — use it for cards and the first
  terminal shot only.
- Caption HTML vocabulary: `<span class="badge">NEW</span>` amber pill,
  `<span class="hl">` amber highlight, `<span class="dim">` muted. Cards use
  `badge` / `h1`/`h2` / `sub` / `cmds`+`cmd` / `foot` classes from
  `stage.html`.
- Target pacing: money shots hold 3–4s, context shots 2–3s, typing/walk frames
  0.2–0.6s; keep the total near 60s.

## Content accuracy (learned the hard way)

- **Verify install commands against reality**, not the README: check
  `npm view hunkdiff dist-tags`. A prerelease needs `npm i -g hunkdiff@beta`;
  `brew install hunk` only serves stable (homebrew-core Autobump, lags npm) —
  omit brew on prerelease cards.
- **Label demo extensions as examples.** The triage board, CSS palette, and
  semver views are `examples/extensions/`, not shipped features — caption them
  with a dimmed `example:` prefix. The real features are the APIs (sidebars,
  file views, commands, dialogs).
- STML requires `--experimental`; say so on the outro card.
- The video is silent — never imply audio in the video or its announcement copy.

## Verification

- Eyeball keyframes in `.video-work/frames/` (Read renders PNGs) after
  capture — especially new scenes — before compositing.
- After encoding, extract spot frames with
  `ffmpeg -y -ss <t> -i launch.mp4 -frames:v 1 check.png` at: a mid-animation
  point (captions must persist), each new scene, and the outro. Check duration
  with `ffprobe -show_entries format=duration`.
- Deliver mp4 (x264, crf 18, faststart — for social/Slack) and webm (vp9,
  crf 32 — for web embeds).
