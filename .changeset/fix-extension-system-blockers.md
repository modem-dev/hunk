---
"hunkdiff": patch
---

Fix extension-system issues found reviewing the published surface:

- `hunkdiff/extension` types now resolve for consumers using `moduleResolution: "nodenext"`, not just `bundler`.
- A VCS adapter whose `detect()` returns an id different from the one it registered under no longer aborts the session with `Unsupported VCS`.
- Extension-registered themes are validated against the same color rules config themes get, so a malformed theme is skipped with a notice instead of crashing the renderer when selected.
- Lifecycle handlers receive a read-only view of the changeset, so an extension that mutates it is reported instead of corrupting the review.
- `startup` now fires for extensions loaded after granting repository trust.
- `--no-extensions` and `--extension` paths survive daemon-driven session reloads, and reloads re-run extension VCS detection the way first launch does.
- An unknown `vcs` id in config is resolved against loaded extension backends, and reported instead of silently discarded when nothing owns it.
- Extension VCS adapters take part in checkout detection on the same terms as bundled ones: the nearest checkout wins, so a Mercurial checkout nested inside a Git repository is reviewed as Mercurial, while `detectionPriority` still decides colocated ties and an explicit `vcs` in config still wins outright.
- `[extensions] paths` now expands a leading `~`, matching the documented examples.
