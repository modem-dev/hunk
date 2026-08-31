import type { ExtensionFactory } from "hunkdiff/extension";

export const AGENT_SKILL_COMMAND = "hunk skill path";
export const AGENT_SKILL_PROMPT_ROWS = [
  "Load the Hunk skill and use it for this review.",
  "Run `hunk skill path` to get the skill path.",
] as const;
export const AGENT_SKILL_PROMPT = AGENT_SKILL_PROMPT_ROWS.join(" ");
export const BUNDLED_AGENT_SKILL_COMMAND_ID = "app.openAgentSkill";
export const BUNDLED_AGENT_SKILL_COMMAND_FULL_ID = `hunk.${BUNDLED_AGENT_SKILL_COMMAND_ID}`;

/** Register Hunk's agent onboarding guidance through the public dialog contract. */
const registerBundledAgentSkill: ExtensionFactory = (hunk) => {
  hunk.registerCommand(
    {
      id: BUNDLED_AGENT_SKILL_COMMAND_ID,
      title: "Show setup guidance for reviewing with an agent",
    },
    async (ctx) => {
      await ctx.dialogs.document({
        title: "Agent skill",
        body: "Teach your agent how to review this Hunk session.",
        copy: {
          label: "Prompt",
          text: AGENT_SKILL_PROMPT,
          displayLines: AGENT_SKILL_PROMPT_ROWS,
        },
      });
    },
  );
};

export default registerBundledAgentSkill;
