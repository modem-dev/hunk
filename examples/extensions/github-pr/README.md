# GitHub pull request extension

Review a GitHub pull request in Hunk with a generic extension-provided CLI command:

```bash
hunk gh 123
```

The extension fetches the PR metadata and diff directly from GitHub's API, writes the diff to a temporary patch, and delegates once to Hunk's built-in `patch` command. Hunk shows the provided title, author, state, repository, and base/head refs in its bundled review-info pane above the diff. The extension has no npm dependencies and does not require the `gh` CLI.

## Try it from this checkout

Place `--extension` before the extension-owned command:

```bash
bun run packages/hunk/src/main.tsx --extension ./examples/extensions/github-pr gh 123
```

A bare number infers `owner/repo` from the current checkout's GitHub `origin`. Explicit forms work outside a checkout and do not invoke Git:

```bash
hunk gh 123 --repo modem-dev/hunk
hunk gh 'modem-dev/hunk#123'
hunk gh https://github.com/modem-dev/hunk/pull/123
```

Quote the `owner/repo#number` form because an unquoted `#` starts a comment in some shells. Use `--` to pass options to the delegated `hunk patch` command:

```bash
hunk gh 123 --repo modem-dev/hunk -- --pager --mode stack
```

Run `hunk gh --help` for the extension-owned help text.

## Install it

This folder is a complete Hunk folder extension. Point `[extensions] paths` at it, copy it into your user extension directory, or install a repository containing it with `hunk extension install`. Once discovered, its command is simply `hunk gh`.

The manifest is marked `private` only to prevent accidental npm publication. Hunk folder discovery and managed Git installation do not require an npm install.

## Authentication and security

Public repositories work anonymously within GitHub's API rate limits. For private repositories or higher limits, set a token:

1. `GH_TOKEN`
2. `GITHUB_TOKEN` when `GH_TOKEN` is absent

The token needs access to the target repository and may require organization SSO authorization. The extension only accepts `github.com` PR URLs and only sends credentials to the fixed `https://api.github.com` endpoint. Redirects are refused, response bodies are not copied into errors, fetched metadata is bounded to 256 KiB, and fetched diffs are bounded to 64 MiB.

Metadata and diff are separate GitHub requests. Hunk intentionally shows only stable provider facts and ref names; it does not claim that the metadata attests the exact bytes returned by the following diff request.

PR patches can contain private source. On POSIX systems, the extension creates a mode-`0700` temporary directory and a mode-`0600` patch. Windows does not enforce those POSIX mode bits; the directory and patch inherit the ACL of the user's system temporary directory. The extension retains the patch while the delegated review can reload, then removes it during extension shutdown. Abrupt process termination may leave cleanup to the operating system's temporary-file policy.

GitHub Enterprise is intentionally outside this example's host and credential policy.
