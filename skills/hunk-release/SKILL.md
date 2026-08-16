---
name: hunk-release
description: Prepares, publishes, verifies, and produces launch media for Hunk stable, prerelease, patch, and backport releases. Use when cutting a release, preparing release metadata or benchmarks, pushing a release tag, generating and embedding its release video, repairing a failed release workflow, or checking npm, GitHub, Homebrew, and mise propagation.
---

# Hunk release workflow

Maintainer-only: this skill requires a Hunk source checkout and repository release permissions. It never ships in the npm package or standalone archives.

Releases publish the `hunkdiff` meta-package plus five platform packages. A pushed `v*` tag starts `.github/workflows/release-prebuilt-npm.yml`, which checks the benchmark gate, builds every platform binary, stages and smoke-tests npm packages, publishes them, attests the release archives, and creates or updates the GitHub release.

## Sources of truth

Read these before changing release state:

| Source                                       | What it controls                                                     |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `AGENTS.md` and `CONTRIBUTING.md`            | Changeset policy and normal validation expectations                  |
| `.github/workflows/release-prebuilt-npm.yml` | Actual build, publish, npm-tag, asset, and GitHub-release automation |
| `benchmarks/release/README.md`               | Benchmark snapshot and accepted-regression policy                    |
| `package.json`                               | Package version and release scripts                                  |
| `CHANGELOG.md`                               | Generated released changelog                                         |

Treat the workflow and scripts as executable truth. Update this skill when they change.

## Safety rules

- Never push a release tag, dispatch a publishing workflow, move or delete a remote tag, publish manually, or edit an existing public release without explicit user confirmation.
- Never infer the target version, npm dist-tag, or release branch when the request is ambiguous. Ask.
- Never reuse or move a version after any package with that version has reached npm. Prepare a new version instead.
- Never bypass a benchmark regression silently. Fix it, record an approved `acceptedRegressions` rationale in the snapshot, or use the workflow's manual override only with explicit approval and a durable reason.
- Never rerun publishing blindly after a partial npm release. Inventory every package/version first; npm versions are immutable.
- Keep credentials and tokens out of commands, logs, release notes, commits, and generated artifacts.

## 1. Choose the release shape

Confirm all of the following:

- target version and tag (`vX.Y.Z` or a supported `-alpha`, `-beta`, or `-rc` prerelease);
- release branch (`main` for the next normal release, or the selected maintenance branch for a backport);
- npm dist-tag (`latest` for a stable version newer than the current npm latest, `beta` for recognized prereleases, or `backport-X.Y` for an older-series stable backport);
- previous tag on that release branch;
- whether the release includes any explicitly accepted benchmark tradeoff.

For patch releases and backports, derive notes from the commits between the previous tag and the release tip on that branch. Do not include features that exist only on `main`. The workflow compares a stable tag with npm's current `latest`: a newer version advances npm and GitHub latest, while an older-series backport publishes under `backport-X.Y` and leaves both latest pointers unchanged.

If `.changeset/pre.json` exists, inspect it before running Changesets commands. Do not enter, exit, or alter prerelease mode without confirming the intended channel and promotion plan.

## 2. Preflight the checkout

Start from a clean, current checkout of the release branch:

```sh
git status --short --branch
git fetch origin --tags --prune
git log --oneline --decorate -10
git tag --sort=-version:refname | head -10
bun --version
bun install --frozen-lockfile
bun run changeset:status
```

Stop if:

- the worktree contains unrelated edits;
- the branch or previous tag is uncertain;
- pending Changesets describe work absent from this branch;
- the requested version conflicts with Changesets' calculated bump;
- the installed Bun version differs from the version pinned by release CI in the workflow and the difference could affect generated locks, binaries, or benchmarks.

Read every pending non-empty Changeset. Confirm that summaries are concise, user-visible, and accurate. Empty Changesets should correspond to maintenance-only work.

## 3. Prepare release metadata

Run Changesets rather than editing versions or the changelog by hand:

```sh
bun run release:version
```

Review the complete generated diff:

```sh
git status --short
git diff -- package.json packages CHANGELOG.md .changeset
```

Verify:

- every publishable package has the intended version;
- consumed Changesets are removed and unrelated Changesets remain;
- the new `CHANGELOG.md` section describes only work present on this branch;
- entries emphasize user-visible behavior rather than internal refactors;
- prerelease state, when present, matches the requested channel.

Do not hand-edit generated version fields merely to force a different bump. Correct the Changesets or release plan and regenerate.

## 4. Generate and compare the release benchmark

After `package.json` contains the target version, run:

```sh
bun run bench:release
bun run bench:release:compare
```

This creates `benchmarks/release/bench-X.Y.Z.json`. Review the comparison, runtime metadata, and any borderline metrics. Use additional focused samples when a result sits near its threshold.

A material regression blocks the tag. If the user explicitly accepts a tradeoff, add the exact metric name and concrete rationale to the snapshot's `acceptedRegressions` array as described in `benchmarks/release/README.md`, then rerun the comparison. Do not replace current results with an older machine's snapshot to make the gate pass.

Commit the snapshot as part of the release-preparation series. The release tag must contain it.

## 5. Validate the release candidate

Run the repository checks before tagging:

```sh
bun run typecheck
bun test
bun run lint
bun run format:check
bun run check:docs
bun run check:pack
bun run build:prebuilt:npm
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
```

Also run the validation required by the changes being released. Rendering or interaction releases require PTY/TTY coverage from `AGENTS.md`; packaging or CLI changes require their relevant source and install smoke paths.

Inspect the packed package and local smoke output for the intended version. The cross-platform workflow remains authoritative for the five release binaries.

## 6. Review and commit release preparation

Review all generated files and draft the eventual GitHub release body before publishing. Typical commit titles are:

```text
chore(release): prepare X.Y.Z
chore(release): add X.Y.Z benchmark snapshot
```

One commit or a short preparation series is acceptable. Keep source changes out of release-only commits. Follow the repository's normal PR and branch policy, and let required CI pass before tagging.

Immediately before tagging, verify that the local release tip is the reviewed remote tip and still clean:

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
git status --short --branch
git log -1 --format='%H %s'
```

## 7. Tag and start publishing

Present the user with:

- target tag and commit SHA;
- previous tag and release branch;
- Changeset/version result;
- benchmark result and any accepted regressions;
- validation commands and outcomes;
- draft release highlights.

Ask for explicit confirmation to push the tag. After confirmation, create an annotated tag and push it:

```sh
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin "vX.Y.Z"
```

A normal release uses the tag push. Do not dispatch the workflow with `publish: true` as a substitute unless recovering from a reviewed exceptional case. The workflow resolves the release channel before building: recognized alpha/beta/rc tags use `beta`; a stable version newer than npm latest uses `latest`; and an older stable backport uses `backport-X.Y` without replacing GitHub's latest release.

Find the tag-push run by its exact commit and fail if GitHub has not registered it yet:

```sh
release_sha=$(git rev-parse "vX.Y.Z^{}")
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

If the run lookup is empty, wait for GitHub to register the tag-triggered run and repeat the lookup rather than selecting an unrelated run. Do not announce success until the benchmark, all platform builds, staging smoke test, npm publish, attestation, and GitHub release jobs succeed.

## 8. Verify published artifacts

Verify the meta-package, every platform package, and the expected dist-tag before producing release media:

```sh
version=X.Y.Z
npm view "hunkdiff@$version" version
for package in \
  hunkdiff-darwin-arm64 \
  hunkdiff-darwin-x64 \
  hunkdiff-linux-arm64 \
  hunkdiff-linux-x64 \
  hunkdiff-windows-x64; do
  npm view "$package@$version" version
done
npm view hunkdiff dist-tags --json
```

Inspect the GitHub release and its five attested binary archives:

```sh
gh release view "v$version" --json tagName,name,isPrerelease,url,assets,body
```

Confirm that package versions, the tag, and all five archives identify the same release. Confirm the workflow's attestation step covered the exact binary archives. Stop here if publication is incomplete or inconsistent; do not build a release video that advertises an unverified release.

## 9. Generate the release video and curate GitHub

After artifact verification succeeds, read `skills/hunk-launch-video/SKILL.md` completely and follow its full-release recipe. Use the released `CHANGELOG.md` section and verified install channels as the editorial source. Confirm the 4–6 release highlights with the user before capture, then generate and inspect both H.264 MP4 and WebM outputs.

Produce the video from a dedicated worktree at the published tag so capture reflects the exact released code and storyboard edits cannot alter the release checkout:

```sh
version=X.Y.Z
git worktree add --detach "../hunk-release-video-$version" "v$version"
```

Run the launch-video workflow from that worktree. Keep its tracked storyboard or scene edits available for review, but never amend the published release commit or move its tag. Ask separately before preserving those editorial changes in a follow-up branch or PR; otherwise remove the worktree after delivery.

A release video is part of the release unless the user explicitly decides to omit it. Rename the approved outputs with the version before embedding or delivery:

```sh
version=X.Y.Z
cp .video-work/launch.mp4 ".video-work/hunk-$version-release.mp4"
cp .video-work/launch.webm ".video-work/hunk-$version-release.webm"
```

Verify duration, file sizes, spot frames, captions, version badges, and install commands using the launch-video skill. Keep the H.264 MP4 within GitHub's applicable video-attachment limit; re-encode rather than silently falling back to a non-playing link.

Embed the H.264 MP4 as an inline player in the mutable release description rather than as an immutable release asset. After upload approval, open the release editor in GitHub, attach the MP4 to the description, and capture the generated `https://github.com/user-attachments/assets/...` URL. Put that bare URL on its own line near the top of the release body so GitHub renders its video player.

The generated video stays outside Git and outside the release's immutable asset set. The tracked storyboard, scenes, and captions are its reproducible source. Archive the MP4 or WebM in separate media storage only when the user requests a durable downloadable copy; do not add generated videos to this repository or Git LFS by default.

The workflow initially uses GitHub-generated notes. Treat those as a draft. Compare them with the released changelog and actual branch diff, then draft the final body with a placeholder for the inline video:

```md
## What's Changed

https://github.com/user-attachments/assets/<video-id>

### Highlights

- <concise user-visible change> by @<author> in <PR URL>
- ...

**Full Changelog**: https://github.com/modem-dev/hunk/compare/<previous-tag>...<new-tag>
```

List only changes actually shipped. Prefer a few clear user-visible highlights over internal refactors. Mark prereleases correctly and verify the title and comparison link.

Write the complete body to a temporary file and review it. Present the video filename and final notes for explicit confirmation before uploading or editing the public release.

After confirmation:

1. Attach the MP4 in GitHub's release editor and copy the generated user-attachment URL.
2. Replace the placeholder in `/tmp/hunk-release-notes.md` with that URL.
3. Apply the reviewed body:

   ```sh
   gh release edit "v$version" --notes-file /tmp/hunk-release-notes.md
   ```

Verify the result in two ways:

```sh
gh release view "v$version" --json tagName,url,assets,body
```

Then open the public release page in a browser and confirm that the inline player loads and plays, the five immutable binary archives remain present, and the final notes render correctly. JSON/API output alone does not prove inline playback.

## 10. Verify distribution channels

For stable releases that advance `latest`, let `Homebrew/homebrew-core` Autobump create and merge the `hunk <version>` update. Do not open a routine version-bump PR manually. Use `brew bump-formula-pr hunk --version <version>` only when Homebrew maintainers request it or Autobump stalls unexpectedly. After propagation, verify `brew install hunk` resolves to the new version. Older-series backports do not replace the Homebrew formula.

For mise, verify against a fresh aqua registry view:

```sh
MISE_AQUA_BAKED_REGISTRY=false mise latest hunk
```

mise normally uses a baked registry and caches downloaded registry sources for a week, so a stale default result is not release failure evidence. Use `mise cache clear` when a forced refresh is needed. Skip Homebrew and mise claims for prereleases and older-series backports unless those channels explicitly support that release.

## 11. Recover carefully

- **Failure before tag push:** fix the preparation branch, regenerate affected metadata or benchmarks, rerun validation, and request confirmation again.
- **Tag pushed but nothing published:** inspect the workflow failure before deciding whether a remote tag can be replaced. Never move it without explicit approval and proof that no npm package or public release escaped.
- **Some npm packages published:** inventory all six package names at the target version. Do not rerun the publish job blindly; escalate and publish only missing packages from the exact reviewed staged artifacts, or cut a new version when consistency cannot be guaranteed.
- **npm succeeded, GitHub release failed:** preserve the tag and npm versions, rerun only the safe failed workflow jobs or create/repair the GitHub release from the exact workflow artifacts.
- **Release notes wrong:** edit the existing release with a reviewed notes file; do not recreate tags or packages.
- **Video generation or attachment failed:** keep the verified software release intact and retry only after the corrected file and public edit are approved. Do not add the generated video to Git or substitute an unreviewed external host.
- **Inline player failed:** verify that the body contains the GitHub-generated user-attachment URL on its own line and test it in a browser. A plain external link does not satisfy the inline-video requirement.
- **Homebrew or mise delayed:** distinguish ecosystem propagation lag from a Hunk publication failure before intervening.

## Completion report

Report:

- version, tag, commit, release branch, and previous tag;
- benchmark and validation outcomes;
- workflow run URL and job status;
- npm dist-tag and all package versions;
- GitHub release URL, five binary archives, and attestation status;
- release-video filenames, user-attachment URL, duration and sizes, plus browser-confirmed inline playback;
- Homebrew and mise status for stable releases that advance latest;
- any manual override, partial failure, or remaining propagation work.
