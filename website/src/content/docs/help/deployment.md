---
title: Deployment integration
description: Serve the static documentation at hunk.dev/docs without coupling it to the separate marketing application.
---

The documentation build is deliberately independent of the marketing site. Astro emits URLs with the `/docs/` base, so the contents of `website/dist/` must be mounted at that path without stripping it from incoming requests.

## Build the immutable artifact

From the Hunk repository root:

```bash
bun install --frozen-lockfile
bun install --cwd website --frozen-lockfile
bun run generate:docs
bun run website:check
bun run website:build
bun run website:links
```

Archive `website/dist/` as one deployable artifact. Do not regenerate reference pages after the build: `bun run check:docs` ensures the committed references and public agent skill already match their authoritative sources.

## Mount it beside the marketing site

Choose one integration owned by the production deployment:

1. **Static copy:** copy the _contents_ of `website/dist/` into the production artifact's `docs/` directory.
2. **Path-preserving proxy:** deploy `website/dist/` as a static origin and route `/docs` plus `/docs/*` to it while preserving the requested `/docs/...` path.

The static copy is simplest for a single atomic deployment. The proxy keeps build pipelines separate, but the docs origin must receive or map the `/docs` prefix consistently. Do not add a redirect that drops the suffix after `/docs/`.

The separate `hunk-web/` checkout is not part of this plan and is not modified by the documentation build. Its owner must explicitly choose and implement the mount strategy.

## Verify before switching traffic

Test the candidate deployment, then make the route live atomically:

```bash
curl --fail --location https://hunk.dev/docs/
curl --fail https://hunk.dev/docs/sitemap-index.xml
curl --fail https://hunk.dev/docs/pagefind/pagefind.js
curl --fail https://hunk.dev/docs/hunk-review-skill.md
curl --fail https://hunk.dev/docs/og.png
```

In a browser, confirm search returns results, an internal link keeps the `/docs/` prefix, theme selection persists across navigation, and one GitHub edit link opens the matching file. Keep production README or marketing links out of the release until these checks pass on the canonical route.

## Roll back

Restore the previous static docs artifact or remove the `/docs` route. Because no marketing files or data migrations are changed, rollback is a route or artifact swap rather than an application rollback.
