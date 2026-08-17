---
name: hunk-launch-video
description: Produces Hunk videos by driving the real TUI headlessly in a PTY, compositing captioned 1080p frames in Chromium, and encoding with ffmpeg. Use for feature demos, workflow explainers, announcements, launch videos, and full-release roundups.
---

# Hunk video pipeline

Source-checkout only: the pipeline lives in `scripts/launch-video/`, which never ships to npm.
It can be used for pull-request demos as well as maintainer release videos. Unix-only — the
capture scripts exec `/bin/bash`.

Generates product videos where every terminal frame is the real Hunk TUI —
no screen recording, no mockups. Three stages:

```text
capture.ts   (bun)               drive Hunk over a PTY, snap styled keyframes to PNG
compose.mjs  (node + Playwright) render each PNG on a 1920x1080 HTML stage in Chromium
ffmpeg                           encode the composited PNGs at 30fps to mp4/webm
```

Playwright controls headless Chromium: for each planned frame it loads the
terminal PNG onto the HTML stage, applies the window chrome, cards, captions,
and transition state, then screenshots the completed stage back to PNG. ffmpeg
sequences those composited screenshots into the final videos.

The generic machinery (PTY driving, keyframe rendering, storyboard planning,
Chromium compositing, the stage template) is the `@hunk/term-video` workspace
package in `packages/term-video/`; `scripts/launch-video/` holds only Hunk's
scenes, captions, and cards on top of it.

## Choosing a recipe

The pipeline is not release-specific. Choose the editorial scope, then use the
same capture → composite → encode stages:

- **Single feature:** a short demonstration of one capability or workflow. Use
  the single-feature recipe below and capture only the required scene.
- **Full release:** a multi-feature roundup based on a release's changelog or
  highlights. Use the full-release recipe and update the canonical storyboard.
- **Custom video:** author any set of scenes and `SHOTS` for tutorials,
  comparisons, announcements, or workflow explainers; follow the scene and
  storyboard rules below.

## Creating a video

Expect ~3–6 min for capture and ~2–4 min for compose — run both with a long
timeout (or in the background); each logs per-snap / per-shot progress.
`compose.mjs` needs node ≥ 18 on PATH (bun alone is not enough).

```sh
# 0. dependencies (tuistory is a devDependency; ghostty-opentui arrives transitively)
bun install    # if a postinstall hook fails in a sandbox, retry with --ignore-scripts

# 1. capture keyframes. Output defaults to <repo>/.video-work/ regardless of
#    cwd (pass a path argument to override), but the PROCESS must run from the
#    repo root — see gotchas.
bun run scripts/launch-video/capture.ts

# 2. one-time portable compositor setup. Playwright installs a Chromium build
#    that exactly matches its browser driver (see gotchas to reuse a system or
#    sandbox browser instead).
printf '{"name":"hunk-video-work","private":true}\n' > .video-work/package.json
cd .video-work
bun add playwright playwright-core
bunx playwright install chromium
cd ..

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

## Single-feature recipe

For a short test, demo, or one-feature announcement, capture and composite only
the scene for that feature:

1. Pick one user-visible capability and find its scene name in the
   `wants("...")` guards. If it does not have a scene, author one using the
   guidance below. Capture only that scene:

   ```sh
   SCENES=review bun run scripts/launch-video/capture.ts
   ```

2. Make a scratch compositor beside the canonical one so its imports and
   repo-relative paths continue to work:

   ```sh
   cp scripts/launch-video/compose.mjs scripts/launch-video/compose-one-feature.mjs
   ```

3. In the scratch copy, trim `SHOTS` to an opening card, only the selected
   feature's frames, and an outro card. Rewrite those cards and captions for
   the scoped cut. Sequence lengths must still match the captured frame names.
4. Composite into the same work directory, then run the normal ffmpeg commands
   with descriptive output names:

   ```sh
   node scripts/launch-video/compose-one-feature.mjs .video-work
   cd .video-work
   ffmpeg -y -f concat -safe 0 -i concat.txt -vf "fps=30,format=yuv420p" \
     -c:v libx264 -preset slow -crf 18 -movflags +faststart hunk-feature-demo.mp4
   ffmpeg -y -f concat -safe 0 -i concat.txt -vf "fps=30,format=yuv420p" \
     -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 hunk-feature-demo.webm
   cd ..
   rm scripts/launch-video/compose-one-feature.mjs
   ```

Keep the scratch compositor uncommitted. The canonical `compose.mjs` remains
the checked-in reference storyboard. If you added a capture scene only to make
PR evidence, revert that scene after encoding; retain it only when it is useful
checked-in demo coverage and belongs to the submitted change.

## Full-release recipe

1. Read the release section in `CHANGELOG.md`. If it has a hand-written
   **Highlights** list (0.18.0 has one; Changesets does not generate them), use
   that list as the storyboard. Otherwise distill 4–6 user-visible headlines
   from the Minor Changes — per-PR entries are too granular to shoot — and
   confirm the shortlist with the user before capturing.
2. Rewrite the canonical storyboard's editorial surface (next section), adding
   or adjusting capture scenes as needed (see "Authoring scenes").
3. Capture every scene referenced by the full storyboard, composite it, and
   encode both formats using the main workflow above.
4. Verify the complete cut (see "Verification") and deliver both files. When `hunk-release` invoked this workflow, return the approved MP4 and WebM to that skill for versioned naming and GitHub user-attachment embedding; do not upload or edit the public release without its confirmation gate.

## Per-video editorial surface

The capture machinery is reusable, but the storyboard is editorial content for
one video. Rewrite it to match the video's scope. As of this writing, the
checked-in reference storyboard is the full 0.18.0 release video:

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
- **Playwright must match the Chromium it drives.** The portable setup above
  installs `playwright` and `playwright-core` together, then downloads their
  matching Chromium build. It works on macOS and Linux and is preferred when
  bandwidth and browser downloads are available; leave `CHROMIUM_PATH` unset
  so Playwright uses that managed browser. On Linux, if Chromium reports
  missing system libraries, run `bunx playwright install-deps chromium` (it
  may require sudo) before retrying.

  To reuse an existing system, CI, or sandbox Chromium instead, install the
  `playwright-core` version provided by that environment and set its executable
  explicitly:

  ```sh
  cd .video-work
  bun add playwright-core@<matching-version>
  cd ..
  CHROMIUM_PATH=/path/to/chromium node scripts/launch-video/compose.mjs .video-work
  ```

  Common executable locations include `$(command -v chromium)` or
  `$(command -v google-chrome)` on Linux and
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS.
  In an environment with a preinstalled Playwright toolchain, read that
  toolchain's `package.json` to get the exact driver version. For example, the
  Anthropic sandbox exposes it through `/opt/pw-browsers/.links/*`:

  ```sh
  cat "$(cat /opt/pw-browsers/.links/* | head -1)/package.json" | grep '"version"'
  # e.g. "1.56.1" -> bun add playwright-core@1.56.1
  ```

  `compose.mjs` picks its browser as `$CHROMIUM_PATH`, then
  `/opt/pw-browsers/chromium` when present, then Playwright's managed browser.

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
- After encoding, return to the repository root, set `VIDEO` to the produced
  MP4, and inspect a mid-animation point, each new scene, and the outro:

  ```sh
  VIDEO=.video-work/hunk-feature-demo.mp4 # or .video-work/launch.mp4
  ffmpeg -y -ss 2 -i "$VIDEO" -frames:v 1 .video-work/check.png
  ffprobe -show_entries format=duration "$VIDEO"
  ```

  Captions must persist through the extracted animation frames.

- Outputs stay under `.video-work/`: the full-release recipe creates
  `launch.mp4`/`launch.webm`, while the single-feature recipe above creates
  `hunk-feature-demo.mp4`/`hunk-feature-demo.webm`. `.video-work/` is
  gitignored — never commit the video or its frames. For a standalone video
  request, send both files to the user directly (mp4: social/Slack; webm: web
  embeds), report duration and file sizes, and flag if the mp4 exceeds ~10 MB
  (Slack) or ~15 MB (X). When invoked by `hunk-release`, hand both files back
  to that workflow instead; it owns versioned filenames, GitHub's
  user-attachment limit, public embedding, and inline-player verification.
  Copy them elsewhere only if the user names a destination.
