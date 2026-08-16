---
name: hunk-release
description: Prepares, publishes, verifies, and curates Hunk releases. Use for release metadata, benchmarks, tags, publishing, release videos, backports, or recovery.
---

# Hunk release workflow

Maintainer-focused and source-checkout only. The tag workflow publishes `hunkdiff` plus five platform packages, attests the binary archives, and creates the GitHub release.

## Safety

- Ask when the version, release branch, previous tag, or channel is ambiguous.
- Get explicit confirmation before pushing a tag, triggering publication, or editing a public release.
- Never reuse an npm version or move a tag after publication.
- Never bypass a benchmark regression without an approved, recorded reason.
- Never retry a partial publish before inventorying every package and artifact.

## 1. Confirm the release

Record the version, tag, branch, previous tag, and expected channel:

- newer stable: npm `latest` and GitHub Latest;
- prerelease: npm `beta`, not GitHub Latest;
- older-series backport: npm `backport-X.Y`, leaving both latest pointers unchanged.

For backports, include only commits present between the previous tag and the release tip on that maintenance branch. Inspect `.changeset/pre.json` before changing prerelease state.

## 2. Prepare

Start from a clean, current release branch:

```sh
git status --short --branch
git fetch origin --tags --prune
git tag --sort=-version:refname | head -10
bun install --frozen-lockfile
bun run changeset:status
```

Read the pending Changesets, then generate metadata:

```sh
bun run release:version
git diff -- package.json packages CHANGELOG.md .changeset
```

Verify the intended versions, consumed Changesets, and new changelog section. Do not force a bump by hand-editing generated versions.

Generate and compare the committed release benchmark:

```sh
bun run bench:release
bun run bench:release:compare
```

A material regression blocks the release unless the user approves an `acceptedRegressions` entry following `benchmarks/release/README.md`.

Run the validation required by `AGENTS.md`, plus the release packaging checks:

```sh
bun run check:docs
bun run check:pack
bun run build:prebuilt:npm
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
```

Commit the generated metadata and `benchmarks/release/bench-X.Y.Z.json`, follow normal review policy, and wait for required CI.

## 3. Tag and publish

Immediately before tagging, fail unless the reviewed branch tip is clean and matches its remote:

```sh
set -euo pipefail
branch=$(git branch --show-current)
test -n "$branch"
git fetch origin "$branch" --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")"
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  git status --short
  exit 1
fi
git log -1 --format='%H %s'
```

Present the tag, commit, benchmark result, validation, and release highlights. After explicit confirmation:

```sh
version=X.Y.Z
tag="v$version"
git tag -a "$tag" -m "$tag"
git push origin "$tag"
```

The tag push starts `.github/workflows/release-prebuilt-npm.yml`. Find only the run for that tagged commit and propagate failure:

```sh
release_sha=$(git rev-parse "$tag^{}")
run_id=$(
  gh run list \
    --workflow release-prebuilt-npm.yml \
    --event push \
    --commit "$release_sha" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // empty'
)
test -n "$run_id"
gh run view "$run_id" --json url,status,conclusion
gh run watch "$run_id" --exit-status
```

If lookup is empty, repeat it after GitHub registers the run; never select an unrelated run. Success requires the benchmark, all builds, staging smoke test, npm publish, attestation, and GitHub release jobs.

## 4. Verify publication

Check the meta-package, platform packages, dist-tags, release body, and five binary archives:

```sh
npm view "hunkdiff@$version" version
for package in \
  hunkdiff-darwin-arm64 hunkdiff-darwin-x64 \
  hunkdiff-linux-arm64 hunkdiff-linux-x64 \
  hunkdiff-windows-x64; do
  npm view "$package@$version" version
done
npm view hunkdiff dist-tags --json
gh release view "$tag" --json tagName,name,isPrerelease,url,assets,body
```

Stop if versions, channel, tag, archives, or attestations disagree.

## 5. Add the release video and final notes

Only after publication verifies, create a detached worktree at the released tag and follow `skills/hunk-launch-video/SKILL.md`'s full-release recipe:

```sh
git worktree add --detach "../hunk-release-video-$version" "$tag"
```

That skill owns capture, encoding, and media checks. Keep generated media out of Git and Git LFS. Preserve storyboard edits only with separate approval.

Draft the final body from the released changelog and actual branch diff:

```md
## What's Changed

https://github.com/user-attachments/assets/<video-id>

### Highlights

- <concise shipped change> by @<author> in <PR URL>

**Full Changelog**: https://github.com/modem-dev/hunk/compare/<previous-tag>...<new-tag>
```

Present the local MP4 and draft notes for explicit confirmation. Then attach the H.264 MP4 in GitHub's release editor, replace the placeholder with its generated user-attachment URL, and apply the reviewed body:

```sh
gh release edit "$tag" --notes-file /tmp/hunk-release-notes.md
```

Open the public release in a browser and verify inline playback, final notes, and the unchanged five immutable binary archives.

## 6. Distribution channels

Only stable releases that advance `latest` should propagate to Homebrew and mise. Let Homebrew Autobump update `Homebrew/homebrew-core`; use `brew bump-formula-pr` only if maintainers request it or Autobump stalls. Verify mise against fresh registry data:

```sh
MISE_AQUA_BAKED_REGISTRY=false mise latest hunk
```

Use `mise cache clear` only when cached registry data is stale. Do not claim Homebrew or mise support for prereleases or older-series backports.

## Failure invariants

- Before tag push: fix, regenerate, validate, and request confirmation again.
- After any npm publication: keep the version and tag; inventory all six packages before recovery.
- Keep a verified software release intact when video or notes fail; retry only the approved media/edit step.
