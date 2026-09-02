---
title: Deployment integration
description: Publish the Hunk landing page and documentation together from one Astro build.
---

The `website/` Astro project owns the complete `hunk.dev` site:

- `/` is the marketing landing page.
- `/docs/` and `/docs/*` are the Starlight documentation.
- `/pagefind/` contains the documentation search index.
- `/docs/hunk-review-skill.md` publishes the generated agent skill.

One static build keeps navigation, metadata, and deployment atomic. Do not copy the docs into the former `hunk-web` repository or operate a second docs origin.

## Build the immutable artifact

From the Hunk repository root:

```bash
bun install --frozen-lockfile
bun install --cwd website --frozen-lockfile
bun run website:check
bun run website:build
bun run website:links
```

Archive `website/dist/` as one deployable artifact. `bun run website:build` checks that generated references and the public agent skill still match their authoritative runtime sources before Astro builds the site.

## Deploy with Vercel

The repository-level `vercel.json` defines the install command, build command, Astro framework, and `website/dist` output directory. Configure one Vercel project with:

- **Git repository:** `modem-dev/hunk`
- **Root directory:** repository root
- **Production branch:** `main`
- **Domain:** `hunk.dev` and `www.hunk.dev`
- **Optional environment variable:** `GITHUB_TOKEN` for authenticated build-time star counts

Vercel should deploy pushes to `main` after the website and repository checks pass. Pull requests can use preview deployments from the same project.

## Cut over from `hunk-web`

1. Deploy this repository to a Vercel preview and verify both `/` and `/docs/`.
2. Move `hunk.dev` and `www.hunk.dev` from the old `hunk-web` Vercel project to the unified project.
3. Verify production before disabling the old project.
4. Archive `modem-dev/hunk-web` after the cutover so the landing page does not drift into a second implementation.

The domain move is the only production switch. No proxy, rewrite, or `/docs` path mount is required.

## Verify before switching traffic

```bash
curl --fail --location https://hunk.dev/
curl --fail --location https://hunk.dev/docs/
curl --fail https://hunk.dev/sitemap.xml
curl --fail https://hunk.dev/pagefind/pagefind.js
curl --fail https://hunk.dev/docs/hunk-review-skill.md
curl --fail https://hunk.dev/og.png
```

In a browser, confirm the landing page links to the docs, theme previews switch, the install command copies, documentation search returns results, theme selection persists across docs navigation, and a GitHub edit link opens the matching source file.

## Roll back

Reassign the domains to the previous Vercel project or promote the last known-good unified deployment. The site is static and has no data migration, so rollback is a domain or deployment promotion rather than an application recovery.
