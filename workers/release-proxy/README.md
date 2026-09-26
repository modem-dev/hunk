# Hunk release proxy

This Cloudflare Worker serves `GET /v1/curl/latest`. It normalizes GitHub's latest stable Hunk
release to:

```json
{ "version": "0.20.1" }
```

A cron trigger refreshes that version in Workers KV every minute. Requests read KV instead of
GitHub, so release-check traffic cannot consume GitHub's API quota. Failed refreshes preserve the
last valid version, while metadata older than six hours returns an endpoint error so Hunk can use
its direct-GitHub fallback. Unchanged metadata writes a fresh heartbeat at most once per hour.

The Worker writes one structured `release_check` log containing only allowlisted `source` and
`currentVersion` values. Scheduled attempts write a bounded `release_refresh` result. Client
responses use `Cache-Control: no-store` so Cloudflare's outer cache cannot bypass the Worker and its
per-request log. It does not use cookies, request bodies, or installation identifiers. Cloudflare's
infrastructure may provide its own request metadata subject to the account's log and retention
configuration.

## Development

```sh
npm install
bun test
npm run typecheck
npm run dev
```

## Deployment

The committed `RELEASE_METADATA` binding points at the production KV namespace. Before the first
deployment, add a read-only GitHub credential as a Worker-scoped secret:

```sh
npx wrangler secret put GITHUB_TOKEN
```

`wrangler deploy` publishes the Worker and its every-minute cron trigger to the configured
`updates.hunk.dev` custom domain. The `release-proxy.yml` workflow checks pull requests and `main`
without receiving production credentials; deployment stays a manual operation from a trusted
maintainer machine:

```sh
npm ci
npm test
npm run typecheck
npm run deploy
curl -fsS https://updates.hunk.dev/v1/curl/latest
```

The client and installer fall back directly to GitHub, so their rollout does not depend on
deployment ordering. Verify the endpoint and its bounded structured logs after each deployment.
Keep the GitHub credential in the Worker secret, never in Hunk or Wrangler configuration.
