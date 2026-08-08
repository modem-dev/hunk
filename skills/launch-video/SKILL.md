---
name: launch-video
description: Produces hunk launch/release videos by driving the real TUI headlessly in a PTY, compositing captioned 1080p frames in Chromium, and encoding with ffmpeg. Use when asked to create, update, or re-cut a release announcement, demo, or launch video for hunk.
---

# Launch video pipeline

Maintainer-only: requires a hunk source checkout (the pipeline lives in
`scripts/launch-video/`, which never ships to npm). Unix-only — the capture
scripts exec `/bin/bash`.

Generates release videos where every terminal frame is the real Hunk TUI —
no screen recording, no mockups. Three stages:

```text
capture.ts   (bun)   drive Hunk over a PTY, snap styled keyframes to PNG
compose.mjs  (node)  composite keyframes onto a 1920x1080 stage, emit frames + concat list
ffmpeg               encode the concat list at 30fps to mp4/webm
```

The generic machinery (PTY driving, keyframe rendering, storyboard planning,
Chromium compositing, the stage template) is the `@hunk/term-video` workspace
package in `packages/term-video/`; `scripts/launch-video/` holds only hunk's
scenes, captions, and cards on top of it.

## Recreating a video

Expect ~3–6 min for capture and ~2–4 min for compose — run both with a long
timeout (or in the background); each logs per-snap / per-shot progress.
`compose.mjs` needs node ≥ 18 on PATH (bun alone is not enough).

```sh
# 0. dependencies (tuistory + ghostty-opentui are devDependencies)
bun install    # if a postinstall hook fails in a sandbox, retry with --ignore-scripts

# 1. capture keyframes. Output defaults to <repo>/.video-work/ regardless of
#    cwd (pass a path argument to override), but the PROCESS must run from the
#    repo root — see gotchas.
bun run scripts/launch-video/capture.ts

# 2. one-time compositor setup: playwright-core matching the Chromium you'll
#    render with (resolution procedure in gotchas)
printf '{"name":"hunk-video-work","private":true}\n' > .video-work/package.json
cd .video-work && bun add playwright-core@<exact-version> && cd ..

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

Scene names are the `wants("...")` guards in `capture.ts`'s `main()`. Note
`SCENES=` only narrows _capture_; `compose.mjs` preflights that every frame its
`SHOTS` table references exists in `frames/` and fails fast listing any missing
ones, so a full composite still needs every scene captured at least once.

## Updating for a new release

1. Read the new release section in `CHANGELOG.md`. If it has a hand-written
   **Highlights** list (0.18.0 has one; Changesets does not generate them),
   that list is the storyboard. Otherwise distill 4–6 user-visible headlines
   from the Minor Changes — per-PR entries are too granular to shoot — and
   confirm the shortlist with the user before capturing.
2. Rewrite the per-release editorial surface (next section), adding or
   adjusting capture scenes as needed (see "Authoring scenes").
3. Re-run the pipeline, verify (see "Verification"), and deliver both files.

## Per-release editorial surface

Everything here is content about a specific release — rewrite it each time.
As of this writing it reflects 0.18.0:

- `compose.mjs`: the whole `SHOTS` table; `OPEN_CARD` (version badge);
  `OUTRO_CARD` (headline, install commands, footer); `EXTENSIONS_CARD`; every
  `<span class="badge">NEW</span>` in captions — a NEW badge is a claim about
  _this_ release, so drop or move them as features age.
- `capture.ts`: the scene functions and the `wants()` guards in `main()` are
  the current storyboard's scene list, plus hunk-side glue (`launchHunk`,
  `launchHunkShell`, `createDemoRepo`, the keyboard probe).

Reusable machinery lives in `@hunk/term-video` (`packages/term-video/`) —
extend it there, don't fork it into the scripts: `createKeyframer`,
`launchApp`/`launchShell`, `createCommandWrapper`, `typeCommand`,
`ensureKeyboardIsLive`, `makeSceneFilter` (`src/capture.ts`); the unit-tested
storyboard planner with the caption/timing semantics (`src/plan.mjs`);
`composeStoryboard` with font/Chromium resolution and the missing-keyframe
preflight (`src/compose.mjs`); and the stage template (`src/stage.html`).

## Environment gotchas

Sandbox-specific bullets are marked; each cost real debugging time.

- **Run `capture.ts` with bun from the repo root.** tuistory uses subpath
  self-imports (`tuistory/pty`) that only resolve inside this repo's
  `node_modules`; running the script from elsewhere resolves tuistory from
  bun's global cache and crashes. (Output location is unaffected — it defaults
  to `<repo>/.video-work/` via `import.meta.url`.)
- **ghostty-opentui is a transitive dep** (via tuistory) with an exports map:
  import `"ghostty-opentui/image"` (not `.../dist/image.js`), resolved
  relative to tuistory — `@hunk/term-video/capture`'s `createKeyframer` does
  the `Bun.resolveSync` dance.
- **playwright-core must match the Chromium it drives.** In the Anthropic
  sandbox, resolve the exact version from the preinstalled toolchain:

  ```sh
  cat "$(cat /opt/pw-browsers/.links/* | head -1)/package.json" | grep '"version"'
  # e.g. "1.56.1" -> bun add playwright-core@1.56.1
  ```

  `compose.mjs` picks its browser as `$CHROMIUM_PATH`, else
  `/opt/pw-browsers/chromium` (sandbox), else playwright-core's own
  resolution. Off the sandbox: `cd .video-work && bun add playwright &&
bunx playwright install chromium`, leave `CHROMIUM_PATH` unset, and match
  `playwright-core` to that `playwright` version.

- **Give `.video-work/` its own `package.json` before `bun add`.** Without
  one, bun walks up and installs into the repo's `package.json` — revert with
  `git checkout package.json bun.lock` if that happens.
- **Chromium needs `--allow-file-access-from-files`** (already in
  `compose.mjs`): the stage samples each keyframe through a canvas to
  color-match the window background, and file:// images taint the canvas
  without it.
- **mp4 needs an ffmpeg with libx264.** Sandbox: `apt-get install ffmpeg`
  (run `apt-get update` first if packages 404). macOS: `brew install ffmpeg`.
  Verify `ffmpeg -encoders | grep -E 'libx264|libvpx-vp9'` shows both before
  encoding — playwright's bundled `ffmpeg-*/ffmpeg-linux` only does VP8/WebM
  and cannot produce the mp4.
- **Caption font**: JetBrains Mono ships inside ghostty-opentui;
  `findCaptionFont` in `packages/term-video/src/compose.mjs` searches bun's
  isolated layout (`node_modules/.bun/node_modules/…`) then a hoisted
  `node_modules/…`. If it still throws `caption font not found`, locate the
  file with `find node_modules -name jetbrains-mono-nerd.ttf` and pass it as
  `fontPath` to `composeStoryboard`.

## Authoring scenes (capture.ts)

- Shared geometry is 140x32 cells rendered at fontSize 16 / dpr 2 → 2688x1536
  PNGs. Keep every scene at this size so all frames fit one window.
- Helpers: `createDemoRepo()` and `launchHunkShell()` are hunk-side glue in
  the script (git repo built from `examples/2-mini-app-refactor`; interactive
  bash with a real `hunk` command on PATH and a clean `❯` prompt); `snap`,
  `typeCommand`, `launchApp`/`launchShell`, and `createCommandWrapper` come
  from `@hunk/term-video/capture`.
- Always `waitForText` on scene-specific content before the first snap, and
  call `ensureKeyboardIsLive()` before scripted keypresses — the first key
  after startup can be dropped (real race, the helper toggles `?` to prove
  keys land).
- **Animation = one snap per keypress.** Cursor walks and typing effects are
  just every `j`/`k`/character captured as its own frame and played back at
  0.2–0.3s per frame. Prefer this over sparse keyframes: three stills read as
  a slideshow, per-press frames read as motion.
- `renderTerminalToImage` auto-trims trailing blank rows, so short outputs
  (CLI scenes) produce short PNGs — the stage handles this by sampling the
  image's bottom-left pixel and painting the window body to match.
- `manifest.json` is a capture-side inventory of the _current run_ only;
  `compose.mjs` ignores it (frames resolve by name from `SHOTS`), and after a
  `SCENES=` run it is partial while `frames/` stays cumulative.
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
- **Sequence lengths must match capture loop bounds**: `walk("j", 10)` in
  `capture.ts` produces `review-walk-00..09`, consumed by
  `Array.from({length: 9})` (+ the opening frame) in `SHOTS`. Change one side
  and the other breaks — the preflight check names any frame that's missing.
- `enter: true` fades/scales the surface in — use it for cards and the first
  terminal shot only.
- Caption HTML vocabulary: `<span class="badge">NEW</span>` amber pill,
  `<span class="hl">` amber highlight, `<span class="dim">` muted. Cards use
  `badge` / `h1`/`h2` / `sub` / `cmds`+`cmd` / `foot` classes from
  `packages/term-video/src/stage.html`.
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
- Window titles are decorative but must not lie: the shell scenes run bash,
  so keep their titles generic (`shell — …`) rather than naming a shell the
  capture doesn't launch.
- STML requires `--experimental`; say so on the outro card.
- The video is silent — never imply audio in the video or its announcement copy.

## Verification and delivery

- Eyeball keyframes in `.video-work/frames/` (Read renders PNGs) after
  capture — especially new scenes — before compositing.
- After encoding, extract spot frames with
  `ffmpeg -y -ss <t> -i launch.mp4 -frames:v 1 check.png` at: a mid-animation
  point (captions must persist), each new scene, and the outro. Check duration
  with `ffprobe -show_entries format=duration`.
- Outputs land at `.video-work/launch.mp4` and `.video-work/launch.webm`.
  `.video-work/` is gitignored — never commit the video or its frames. Send
  both files to the user directly (mp4: social/Slack; webm: web embeds),
  report duration and file sizes, and flag if the mp4 exceeds ~10 MB (Slack)
  or ~15 MB (X). Copy them elsewhere only if the user names a destination.
