# Hunk release proxy

This stateless Cloudflare Worker serves `GET /v1/curl/latest`. It caches and normalizes GitHub's
latest stable Hunk release to:

```json
{ "version": "0.20.1" }
```

The Worker writes one structured `release_check` log containing only allowlisted `source` and
`currentVersion` values. It does not use D1, cookies, request bodies, or installation identifiers.
Cloudflare's infrastructure may provide its own request metadata subject to the account's log and
retention configuration.

## Development

```sh
npm install
bun test
npm run typecheck
npm run dev
```

`wrangler deploy` publishes the Worker to the configured `updates.hunk.dev` custom domain. The
`release-proxy.yml` workflow checks pull requests and deploys changes from `main` after its tests,
typecheck, and deployment dry run pass. Manual dispatches deploy only from `main`. Configure the
`CLOUDFLARE_API_TOKEN` secret in the protected `release-proxy` GitHub environment. The client and
installer fall back directly to GitHub, so their rollout does not depend on deployment ordering;
verify the Worker after its first deployment so release checks produce the intended aggregate logs.
No GitHub token is required for the initial anonymous upstream request; if one is added later, store
it as a Worker secret and never in Hunk.
