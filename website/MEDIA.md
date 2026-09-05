# Documentation media

## Feature showcase captures

`public/feature-*.{webp,mp4,webm}` are captured from the real TUI by `scripts/capture-media.ts`: it drives `bun run packages/hunk/src/main.tsx` inside a PTY (tuistory), renders styled terminal frames to retina images at devicePixelRatio 2 (ghostty-opentui), composites a synthetic mouse pointer where the storyboard moves one (`scripts/assets/pointer.png`), and assembles clips into looping mp4 + webm with ffmpeg. Regenerate after user-visible changes to the review stream, layouts, mouse affordances, or themes:

```bash
bun run website/scripts/capture-media.ts            # everything
bun run website/scripts/capture-media.ts mouse      # one asset: stream|agent|mouse|layout|themes|shots
```

`public/shot-*.webp` are the hero theme picker's stills, one per pill, captured by the same script's `shots` asset. Each is the same split-view review with the sidebar and an agent note showing, so the pills compare themes rather than scenes. The pills live in `src/components/marketing/ThemeShot.astro` and must name the same themes as `HERO_SHOT_THEMES` in the capture script; the "and N more" count reads Hunk's bundled catalog at build time, so it needs no updating when themes are added. Changing the capture's `cols`/`rows` changes the image geometry — update `.shot-stack`'s `aspect-ratio` in `src/styles/marketing.css` to match.

Video assets need an ffmpeg with libx264 and libvpx-vp9 on PATH (or pointed at via `FFMPEG=`). Like the other rituals in this file it is optional and Unix-oriented; website builds and tests never run it.

The two workflow captures in `public/docs/images/` are optimized copies of the current product screenshots embedded in the repository README:

- `review-stream.webp` — `https://github.com/user-attachments/assets/35605618-be3f-479e-b6e0-edb089910651`
- `agent-comments.webp` — `https://github.com/user-attachments/assets/92eb8993-f044-436d-a038-8139da5ad8de`

They teach the full review stream and inline agent-note workflows rather than serving as decorative art. Refresh them when those workflows visibly change.

Image refresh is an optional, Unix-oriented maintainer task; website builds and tests do not invoke it. With ImageMagick installed, resize and strip metadata before committing:

```bash
magick source.png -resize '1400x>' -strip -quality 82 public/docs/images/review-stream.webp
magick source.png -resize '960x>' -strip -quality 82 public/docs/images/agent-comments.webp
```

`public/og.png` is the shared 1200×630 social card for the landing page and documentation. Keep it aligned with the site metadata and paper/green theme.

## Community video thumbnails

`public/video-*.webp` are self-hosted copies of the YouTube thumbnails for the walkthroughs listed in `src/components/marketing/CommunityVideos.astro`. Hosting them here keeps the landing page free of third-party requests, so refresh them by hand when a creator changes their thumbnail:

```bash
curl -sfL https://i.ytimg.com/vi/<video-id>/maxresdefault.jpg -o /tmp/thumb.jpg
magick /tmp/thumb.jpg -resize '900x>' -strip -quality 80 public/video-<channel>.webp
```

Durations in that component are hardcoded because they never change once a video is published. Verify them against the video before adding a new card.

The cards render as paused embeds: the scrim, red play button, and duration badge are drawn locally so nothing loads from YouTube. Channel avatars are currently monogram circles (`initial` + `avatarColor` in the component data). To upgrade a card to the channel's real avatar, self-host it the same way as the thumbnails — save the channel page's avatar image, then:

```bash
magick avatar.jpg -resize 56x56 -strip -quality 80 public/avatar-<channel>.webp
```

and swap the component's monogram span for an `<img>` pointing at it. Keep avatars square at 56px; the CSS rounds them.
