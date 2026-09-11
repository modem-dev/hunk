import { join } from "node:path";
import {
  parseSkillFrontmatter,
  renderAgentSkillStub,
} from "../../packages/hunk/src/core/install/agentSkills";
import { renderHunkReviewSkill } from "../../packages/hunk/src/hunk-review/skillDocument";
import { BUNDLED_SKILL_NAMES } from "../../packages/hunk/src/core/run/paths";

/**
 * Regenerate the checked-in skill artifacts from source.
 *
 * `packages/hunk/skills/hunk-review/SKILL.md` is rendered from the typed agent surface; the
 * colocated skillDocument test fails when it drifts from the renderer. `.agents/skills/<name>/SKILL.md`
 * holds the pointer stub for each bundled skill, the same file `hunk skill install` writes, so
 * `npx skills add modem-dev/hunk` installs a pointer that defers to the installed CLI instead of a
 * copy that goes stale; the agentSkills test fails when those drift. Run this after changing session
 * commands, agent errors, skill prose, or either bundled skill's frontmatter.
 */
const repoRoot = join(import.meta.dir, "../..");
const reviewSkillPath = join(repoRoot, "packages", "hunk", "skills", "hunk-review", "SKILL.md");
await Bun.write(reviewSkillPath, renderHunkReviewSkill());
console.log(`Wrote ${reviewSkillPath}`);

for (const name of BUNDLED_SKILL_NAMES) {
  const bundled = await Bun.file(
    join(repoRoot, "packages", "hunk", "skills", name, "SKILL.md"),
  ).text();
  const pointerPath = join(repoRoot, ".agents", "skills", name, "SKILL.md");
  await Bun.write(pointerPath, renderAgentSkillStub(parseSkillFrontmatter(bundled)));
  console.log(`Wrote ${pointerPath}`);
}
