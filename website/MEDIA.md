# Documentation media

The two workflow captures in `public/docs/images/` are optimized copies of the current product screenshots embedded in the repository README:

- `review-stream.webp` — `https://github.com/user-attachments/assets/35605618-be3f-479e-b6e0-edb089910651`
- `agent-comments.webp` — `https://github.com/user-attachments/assets/92eb8993-f044-436d-a038-8139da5ad8de`

They teach the full review stream and inline agent-note workflows rather than serving as decorative art. Refresh them when those workflows visibly change.

Image refresh is an optional, Unix-oriented maintainer task; website builds and tests do not invoke it. With ImageMagick installed, resize and strip metadata before committing:

```bash
magick source.png -resize '1400x>' -strip -quality 82 public/docs/images/review-stream.webp
magick source.png -resize '960x>' -strip -quality 82 public/docs/images/agent-comments.webp
```

`public/agent-note-zoom.webp` is a zoomed crop of `public/shot-graphite.webp`, framed so the agent note and the lines it annotates are legible at landing-page size. Recrop it from the full-resolution theme shot rather than upscaling this file:

```bash
magick shot-graphite.webp -crop 924x486+1276+318 +repage -strip -quality 82 public/agent-note-zoom.webp
```

The note in that capture renders as "Agent note" because the annotation carries no `author`; a sidecar that names its agent would title the card with that name instead.

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
