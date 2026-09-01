import { describe, expect, mock, test } from "bun:test";
import type { ExtensionCommandContext } from "hunkdiff/extension";
import { getBundledUIRegistry } from "..";
import {
  AGENT_SKILL_PROMPT,
  AGENT_SKILL_PROMPT_ROWS,
  BUNDLED_AGENT_SKILL_COMMAND_FULL_ID,
} from ".";

/** Return the agent-skill registration from the process-static bundled UI registry. */
function getBundledAgentSkillCommand() {
  const registered = getBundledUIRegistry().commands.find(
    ({ extensionId, command }) =>
      `${extensionId}.${command.id}` === BUNDLED_AGENT_SKILL_COMMAND_FULL_ID,
  );
  if (!registered) throw new Error("Bundled agent skill command is missing.");
  return registered;
}

describe("bundled agent skill extension", () => {
  test("registers the shared Hunk command identity without owning its host menu shell", () => {
    const registered = getBundledAgentSkillCommand();

    expect(registered.extensionId).toBe("hunk");
    expect(registered.command).toEqual({
      id: "app.openAgentSkill",
      title: "Show setup guidance for reviewing with an agent",
    });
  });

  test("opens its onboarding through the public info dialog", async () => {
    const info = mock(async () => {});
    const context = { dialogs: { info } } as unknown as ExtensionCommandContext;

    await getBundledAgentSkillCommand().handler(context);

    expect(info).toHaveBeenCalledWith({
      title: "Agent skill",
      body: "Teach your agent how to review this Hunk session.",
      copy: {
        label: "Prompt",
        text: AGENT_SKILL_PROMPT,
        displayLines: AGENT_SKILL_PROMPT_ROWS,
      },
    });
  });
});
