import type { VcsLandingPage } from "../data/vcsLandingPages";

/** Renders the agent-readable counterpart of one VCS landing page. */
export function renderVcsLandingMarkdown(page: VcsLandingPage): string {
  const sections = page.workflows.flatMap((workflow) => [
    `## ${workflow.heading}`,
    "",
    workflow.body,
    "",
  ]);
  const setup = page.setup
    ? [`## ${page.setup.heading}`, "", "```text", ...page.setup.lines, "```", ""]
    : [];

  return [
    `# Hunk for ${page.name}`,
    "",
    `> ${page.description}`,
    "",
    page.answer,
    "",
    "## Start reviewing",
    "",
    "```bash",
    ...page.quickStart,
    "```",
    "",
    ...sections,
    ...setup,
    "## What to know",
    "",
    page.limitations,
    "",
    `[Read the complete ${page.name} workflow documentation](https://hunk.dev${page.docsHref})`,
    "",
    "[Install Hunk](https://hunk.dev/#install)",
    "",
  ].join("\n");
}
