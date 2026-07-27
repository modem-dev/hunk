import { join } from "node:path";
import { renderHunkReviewSkill } from "../src/hunk-review/skillDocument";

/**
 * Regenerate `skills/hunk-review/SKILL.md` from the typed agent surface. The checked-in file is
 * the published artifact; `src/hunk-review/skillDocument.test.ts` fails when it drifts from the
 * renderer, so run this after changing session commands, agent errors, or the skill prose.
 */
const skillPath = join(import.meta.dir, "..", "skills", "hunk-review", "SKILL.md");
await Bun.write(skillPath, renderHunkReviewSkill());
console.log(`Wrote ${skillPath}`);
