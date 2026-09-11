---
"hunkdiff": minor
---

Add `hunk skill install --agent <name>` to teach a coding agent how to drive Hunk in one command. It writes a short pointer `SKILL.md` into the skills directory of Claude Code, Codex, opencode, Cursor, Amp, GitHub Copilot, or any tool reading `.agents/skills`; repeat `--agent` for several, and add `--project` to install into the current repository. The pointer keeps only the skill's name and description and loads the rest through the new `hunk skill show [name]`, so it stays current across Hunk upgrades instead of going stale as a copy. The repository also publishes the same pointer skills under `.agents/skills/`, so `npx skills add modem-dev/hunk -g` installs them through the skills CLI, and the maintainer-only skills are marked internal so that command no longer offers them.
