# Hunk release proxy

This stateless Cloudflare Worker serves `GET /v1/curl/latest`. It caches and normalizes GitHub's
latest stable Hunk release to:

```json
{ "version": "0.20.1" }
```

The Worker writes one structured `release_check` log containing only allowlisted `source` and
`currentVersion` values. Client responses use `Cache-Control: no-store` so Cloudflare's outer cache
cannot bypass the Worker and its per-request log; the Worker Cache API still keeps the normalized
GitHub response for five minutes. It does not use D1, cookies, request bodies, or installation
identifiers. Cloudflare's infrastructure may provide its own request metadata subject to the
account's log and retention configuration.

## Development

```sh
npm install
bun test
npm run typecheck
npm run dev
```

`wrangler deploy` publishes the Worker to the configured `updates.hunk.dev` custom domain. The
`release-proxy.yml` workflow checks pull requests and `main` without receiving production
credentials; deployment stays a manual operation from a trusted maintainer machine:

```sh
npx wrangler login
npm ci
npm test
npm run typecheck
npm run deploy
curl -fsS https://updates.hunk.dev/v1/curl/latest
```

The client and installer fall back directly to GitHub, so their rollout does not depend on
deployment ordering. Verify the endpoint and its bounded structured logs after each deployment. No
GitHub token is required for the initial anonymous upstream request; if one is added later, store it
as a Worker secret and never in Hunk.
