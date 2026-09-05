import { join } from "node:path";
import { renderHunkReviewSkill } from "../packages/hunk/src/hunk-review/skillDocument";

/**
 * Regenerate `packages/hunk/skills/hunk-review/SKILL.md` from the typed agent surface. The checked-in
 * file is the published artifact; the colocated skillDocument test fails when it drifts from the
 * renderer, so run this after changing session commands, agent errors, or the skill prose.
 */
const skillPath = join(
  import.meta.dir,
  "..",
  "packages",
  "hunk",
  "skills",
  "hunk-review",
  "SKILL.md",
);
await Bun.write(skillPath, renderHunkReviewSkill());
console.log(`Wrote ${skillPath}`);
