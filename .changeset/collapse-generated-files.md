---
"hunkdiff": minor
---

Collapse review noise by default: lockfiles, minified bundles, and generated files now render as a single expandable placeholder in the review stream, so real edits stand out in agent changesets. Press `x` to expand or re-collapse the selected file, or click the placeholder to reveal it. Collapse state is preserved across watch-mode reloads. Control the policy with `collapse_generated` in config or the `--collapse-generated` / `--no-collapse-generated` flags.
