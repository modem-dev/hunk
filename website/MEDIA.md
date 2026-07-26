# Documentation media

The two workflow captures in `public/images/` are optimized copies of the current product screenshots embedded in the repository README:

- `review-stream.webp` — `https://github.com/user-attachments/assets/35605618-be3f-479e-b6e0-edb089910651`
- `agent-comments.webp` — `https://github.com/user-attachments/assets/92eb8993-f044-436d-a038-8139da5ad8de`

They teach the full review stream and inline agent-note workflows rather than serving as decorative art. Refresh them when those workflows visibly change.

Image refresh is an optional, Unix-oriented maintainer task; website builds and tests do not invoke it. With ImageMagick installed, resize and strip metadata before committing:

```bash
magick source.png -resize '1400x>' -strip -quality 82 public/images/review-stream.webp
magick source.png -resize '960x>' -strip -quality 82 public/images/agent-comments.webp
```

`public/og.png` is a 1200×630 Hunk-branded social card. Keep its text and palette aligned with the site metadata and paper/green theme.
