---
"hunkdiff": minor
---

Review a GitHub pull request directly with `hunk diff --pr <number|url>`. Hunk shells out to the authenticated GitHub CLI (`gh pr diff --patch`) and feeds the result through the existing patch pipeline, so a PR opens without a manual `gh pr checkout`. Pass `--repo <owner/repo>` to target a repository other than the current directory.
