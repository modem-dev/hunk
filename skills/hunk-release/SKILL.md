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

Read the pending Changesets, then generate metadata and the published release notes:

```sh
bun run release:version
bun run generate:changelog
git diff -- package.json packages CHANGELOG.md .changeset website
```

Verify the intended versions, consumed Changesets, and new changelog section. Do not force a bump by hand-editing generated versions.

`generate:changelog` projects `CHANGELOG.md` into `hunk.dev/changelog`. Never hand-edit its output under `website/src/content/docs/changelog/`, `website/public/changelog/`, `website/releases/dates.json`, or `website/releases/latest.json`. For a minor or major release, add the hand-authored parts to `website/releases/notes.json` under the `major.minor` key and regenerate:

- `summary` — one sentence; replaces the changelog's `### Highlights` lead paragraph on the page.
- `tagline` — short phrase for the landing-page release ribbon.
- `links` — docs pages the highlights describe, rendered as "Related documentation".
- `video` — `mp4` plus optional `webm`, `poster`, `duration`, and `title`, filled in at step 5.

The release tag does not exist yet at this point, so the new version is rendered as `Unreleased` and is deliberately given no install command; the tag date is picked up by the next generation. Recorded dates in `website/releases/dates.json` are never recomputed, which is what lets `check:changelog` gate CI without Git tags.

Generate and compare the committed release benchmark:

```sh
bun run bench:release
bun run bench:release:compare
```

A material regression blocks the release unless the user approves an `acceptedRegressions` entry following `benchmarks/release/README.md`.

Run the validation required by `AGENTS.md`, plus the release packaging checks:

```sh
bun run check:docs
bun run check:changelog
bun run check:pack
bun run build:prebuilt:npm
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
```

Commit the generated metadata and `benchmarks/release/bench-X.Y.Z.json`, then follow normal review
policy. The Firecracker evidence must come from that reviewed release tip, not the pre-generation
commit. Push the reviewed tip before using the manual workflow.

Run the full Firecracker install compatibility suite once from the clean reviewed release tip on a
Linux x64 host with working KVM, either locally or through the manually dispatched
`install-vm.yml` workflow:

```sh
set -euo pipefail
mkdir -p tmp/install-vm/runs
result_dir=$(mktemp -d tmp/install-vm/runs/release-XXXXXXXX)
bun run test:install-vm -- --output "$result_dir"
bun run ./test/cli/install-vm/validate-release-result.ts "$result_dir/result.json"
```

The explicit output directory prevents a failed invocation from falling back to stale evidence. The
validator requires the complete checked-in scenario manifest, passing statuses, and the current
checkout's source identity. A skipped result does not satisfy release validation. For the manual
workflow, dispatch the full suite from the reviewed tip, download its `result.json` beneath the
ignored `tmp/install-vm/` directory of a checkout at that exact tip, and run the validator there; a
green job alone is insufficient because unsupported runners may use the intentional skip path.
Firecracker validates Linux x64 packaging behavior, while the existing native release jobs remain
responsible for macOS, Windows, and other architectures. Wait for required CI before continuing.

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

Then record the tag date and publish the release notes. The published page is what the update notice and the GitHub release body point at, so it is part of the release, not follow-up work:

```sh
bun run generate:changelog
bun run generate:og
git diff --stat -- website
```

This backfills the new tag's date, adds the install command to the series page, moves the landing-page ribbon to the new version, and redraws the social cards whose contents changed. Commit it to `main` — the diff should only touch `website/releases/`, `website/src/content/docs/changelog/`, and the redrawn cards under `website/public/changelog/og/`. Skip this for a prerelease or a backport: neither advances the published latest release.

Prereleases are never published to `hunk.dev/changelog`; they stay on GitHub. The generator drops them, so a beta produces no page, no index row, and no feed item, and a series that has only reached beta has no page at all until its stable release ships.

## 5. Add the release video and final notes

Only after publication verifies, create a detached worktree at the released tag and follow `skills/hunk-launch-video/SKILL.md`'s full-release recipe:

```sh
git worktree add --detach "../hunk-release-video-$version" "$tag"
```

That skill owns capture, encoding, and media checks. Keep generated media out of Git and Git LFS. Preserve storyboard edits only with separate approval.

Publish the video so the release page can carry it, then record it in `website/releases/notes.json` under the series' `video` key and regenerate. Host it where the site can serve it rather than committing it: the 1080p master stays out of Git and Git LFS.

Draft the final body from the released changelog and actual branch diff. Replace GitHub's generated PR inventory with editorial notes that help someone decide whether to install the release:

- Open with one short paragraph describing the release's product theme and user impact.
- Group a small number of meaningful changes under descriptive headings. Explain what users can now do; do not restate commit titles or reproduce the changelog.
- Include both upgrade and npm installation instructions using the exact release: `hunk update <version>` for existing managed installs and `npm install -g hunkdiff@<version>` for npm installs or first-time npm users. Add other installation-method-specific guidance only when relevant.
- Add a clearly labeled compatibility section for runtime requirements, changed CLI interpretation, extension API variants, migrations, or other upgrade risks.
- Add a **Community contributors** section that names every external contributor in the release, links each relevant PR, and briefly describes their contribution. Derive this from the actual release diff; do not limit acknowledgment to first-time contributors and do not bury contributors in an autogenerated list.
- Preserve a complete PR inventory inside a collapsed GitHub `<details>` block after the editorial sections. Use one concise bullet per merged PR with its author and link, include maintenance work there, and verify the list against the actual previous-tag comparison. The collapsed inventory is for completeness; it does not replace the curated highlights or contributor acknowledgments.
- Link the comparison from the actual previous tag. Stable releases also point at `hunk.dev`, which carries the full notes, video, and docs links; prereleases remain self-contained on GitHub because they have no hunk.dev changelog page.
- Keep maintenance-only PRs out of the editorial highlights unless they materially affect installation, compatibility, security, or performance.

Use this shape rather than a flat `What's Changed` list:

````md
## <release name or product theme>

<one short release summary>

```sh
hunk update <version>
npm install -g hunkdiff@<version>
```

https://github.com/user-attachments/assets/<video-id>

### <user-facing theme>

<what changed, why it matters, and links to the defining PRs>

### Compatibility notes

- <upgrade requirement or changed behavior>

### Community contributors

- [@contributor](https://github.com/contributor) <concise contribution>. [#123](PR URL)

<details>
<summary>All merged pull requests</summary>

- <concise PR title> by @author in [#123](PR URL)

</details>

**Release notes**: https://hunk.dev/changelog/<major.minor>/ <!-- stable only -->
**Full changelog**: https://github.com/modem-dev/hunk/compare/<previous-tag>...<new-tag>
````

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
