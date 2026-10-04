# Hunk brand guide

Where Hunk's logo files live, which version to use where, and the colors and type the website is built on. Source of truth for the site look is `website/src/styles/brand.css`; this page records the intent.

## Voice and feel

- Terminal-first, "modern desktop diff tool in a terminal". Monospace everywhere, hard edges, paper-and-ink contrast with one green accent.
- Plain, concrete copy. Tagline: **Made for review.** Eyebrow: **Terminal diffs.** Domain: `hunk.dev`.
- The wordmark is always lowercase and monospace: `hunk`. That applies to the logo and to the header text next to the mark. Running prose, docs, and release notes keep their existing style (`Hunk` as the product name); this rule is about the logo, not copy.

## Logo versions

All files are in `website/public/brand/` and served at `https://hunk.dev/brand/<file>`. They are filled with the ink color `#16140f`; recolor by editing the `fill`, or inline the SVG and use `currentColor`.

| File                | What it is                                                                | Use it for                                                                           |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `logo-mark.svg`     | Flat "h" mark: a framed square with a stem and top-right bar. No outline. | Header, favicon, app icons, avatars, anything under ~40px.                           |
| `logo-mark-3d.svg`  | The "h" block with its offset outline shadow.                             | Large placements only (about 40px and up): hero art, slides, social cards, stickers. |
| `logo-wordmark.svg` | The lowercase `hunk` letters on their own.                                | Next to the mark when the lockup is too heavy; text-only contexts.                   |
| `logo-lockup.svg`   | 3D mark plus wordmark.                                                    | Open Graph images, README banner, talk title slides.                                 |

Other places the mark appears:

| Path                                       | Purpose                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `website/public/favicon.svg`               | Browser tab icon. Flat mark in `#65d291` on a `#111a15` rounded square. |
| `website/public/icon.png`                  | 512px PNG of the favicon (fallback for browsers that skip SVG icons).   |
| `website/public/apple-icon.png`            | 180px apple-touch icon.                                                 |
| `website/src/components/BrandHeader.astro` | Header logo: inline flat mark (24px) plus `hunk` text.                  |
| `website/public/og.png`                    | 1200×630 social card. Not yet on the new logo.                          |
| `website/public/docs/favicon.svg`          | Docs favicon. Not yet updated.                                          |

Regenerate the PNG icons after changing `favicon.svg`:

```bash
rsvg-convert -w 512 -h 512 website/public/favicon.svg -o website/public/icon.png
rsvg-convert -w 180 -h 180 website/public/favicon.svg -o website/public/apple-icon.png
```

### Rules

Clear space and minimum sizes are proposed guidance, not something the site enforces yet.

- **Small means flat.** Below ~40px the 3D outline turns into a smudge; use `logo-mark.svg`.
- **Clear space:** keep at least the width of the stem (about 8% of the mark's width) free on every side. In the lockup, the gap between mark and wordmark is the mark's top-right bar height.
- **Minimum size:** 16px for the flat mark, 40px for the 3D mark, 48px wide for the wordmark.
- **Don't** stretch, rotate, outline, add shadows or gradients, recolor outside the palette below, or retype the wordmark in another font. The wordmark is outlined paths, not live text.
- **Don't** put the mark inside a circle. A rounded square (radius about 19%) is the only container, as in the favicon.

## Color

Light is the default. Dark mode is toggled with `data-theme="dark"`. Tokens live in `website/src/styles/brand.css`.

| Role               | Light     | Dark      | Token                |
| ------------------ | --------- | --------- | -------------------- |
| Background (paper) | `#f4f1ea` | `#0c0e10` | `--hunk-bg`          |
| Surface            | `#fffdf8` | `#14181b` | `--hunk-paper`       |
| Panel              | `#e9e4d8` | `#1b1f24` | `--hunk-panel`       |
| Ink                | `#16140f` | `#f2f4f6` | `--hunk-ink`         |
| Body text          | `#3a352b` | `#c3c9cf` | `--hunk-body`        |
| Muted text         | `#6b6557` | `#9aa4af` | `--hunk-muted`       |
| Rule               | `#dcd6c8` | `#262d34` | `--hunk-rule`        |
| Accent green       | `#1f7a35` | `#5dd06a` | `--hunk-accent`      |
| Accent soft        | `#bfe9c6` | `#2c6b34` | `--hunk-accent-soft` |
| Accent ink         | `#0d3a18` | `#b9f2c0` | `--hunk-accent-ink`  |

- Use the accent green sparingly: the current nav item, the highlighted word in the hero, primary controls.
- The diff colors in screenshots come from the terminal theme, not the brand palette.
- The favicon uses a darker green pair (`#111a15` / `#65d291`) that is not a site token. Align it with the table above or add it as a token if it stays.
- The logo exploration files (C51/C59) were drawn on a saturated blue (`#1F3DFF`). That blue is not part of the site palette; decide before using it anywhere.

## Typography

- **JetBrains Mono** (variable) for everything: headings, body, nav, code, docs. Loaded from `@fontsource-variable/jetbrains-mono` and exposed as `--hunk-font`.
- Fallback stack: `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`.
- Header logo text is 18px, weight 700, `-0.02em` letter-spacing. Check `marketing.css` and `starlight.css` for the other weights in use.
- Eyebrows (like `TERMINAL DIFFS`) are 13px, uppercase, `0.15em` letter-spacing.
- Use the font via `var(--hunk-font)`; never hard-code another family.

## UI details that make it look like Hunk

- Hard 1px ink borders with a solid offset shadow (`--hunk-shadow`) on cards and the install panel, not blur shadows.
- Minimal chrome: a thin top bar and a single rule under it, no redundant headers.
- Terminal screenshots sit in a window frame with three hollow dots.

## Related branding

- **Modem** ("Built by") uses `website/public/modem-light.svg` in the footer. Keep it at its own aspect ratio and don't merge it with the Hunk mark.
- Product name in prose: Hunk. Wordmark and logo text: `hunk`, lowercase. npm package: `hunkdiff`. Command: `hunk`. Repo: `modem-dev/hunk`.

## Updating this guide

When the palette, font, or logo files change, update the tables above in the same change. The site media rituals (OG image, screenshots) are in `website/MEDIA.md`.
