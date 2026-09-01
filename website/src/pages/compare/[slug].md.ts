import type { APIRoute, GetStaticPaths } from "astro";
import {
  COMPARISONS,
  COMPARISONS_REVIEWED_ON,
  SUPPORT_MARKS,
  comparisonUrl,
  type Comparison,
  type Support,
} from "../../data/comparisons";

/**
 * Serves every comparison as Markdown at its own URL plus `.md`.
 *
 * The docs already do this through starlight-dot-md, and robots.txt tells answer
 * engines to prefer Markdown over scraping HTML; these pages are hand-built
 * Astro rather than content collections, so they need their own endpoint to keep
 * that promise. Output is generated from the same catalog entry the HTML page
 * renders, so the two can never disagree about a capability mark.
 */
export const getStaticPaths: GetStaticPaths = () =>
  COMPARISONS.map((comparison) => ({
    params: { slug: comparison.slug },
    props: { comparison },
  }));

/** Markdown table cell for one support mark, readable without the legend. */
function cell(support: Support): string {
  return SUPPORT_MARKS[support].label;
}

/** Escape the pipe characters that would otherwise split a Markdown table cell. */
function tableText(text: string): string {
  return text.replaceAll("|", "\\|");
}

function render(comparison: Comparison): string {
  const { rival } = comparison;
  const lines: string[] = [
    `# ${comparison.headline}`,
    "",
    `> ${comparison.description}`,
    "",
    `Source: ${comparisonUrl(comparison)} · Last checked: ${COMPARISONS_REVIEWED_ON}`,
    "",
    comparison.answer,
    "",
    "## Choose Hunk if",
    "",
    ...comparison.pick.hunk.map((reason) => `- ${reason}`),
    "",
    `## Choose ${rival.name} if`,
    "",
    ...comparison.pick.rival.map((reason) => `- ${reason}`),
    "",
  ];

  for (const section of comparison.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const paragraph of section.body) lines.push(paragraph, "");
    if (section.code) {
      if (section.code.caption) lines.push(`${section.code.caption}:`, "");
      lines.push("```bash", ...section.code.lines, "```", "");
    }
  }

  lines.push(
    `## Hunk vs ${rival.name}, capability by capability`,
    "",
    `${rival.name} is written in ${rival.language} and licensed ${rival.license}. Hunk is TypeScript, MIT, and ships as a standalone binary for macOS, Linux, and Windows.`,
    "",
    `| Capability | Hunk | ${tableText(rival.name)} |`,
    "| --- | --- | --- |",
    ...comparison.capabilities.map((row) => {
      const capability = row.note
        ? `${tableText(row.capability)} — ${tableText(row.note)}`
        : tableText(row.capability);
      return `| ${capability} | ${cell(row.hunk)} | ${cell(row.rival)} |`;
    }),
    "",
    "## Questions people ask",
    "",
  );

  for (const faq of comparison.faqs) {
    lines.push(`### ${faq.question}`, "", faq.answer, "");
  }

  lines.push(
    "## Sources",
    "",
    ...comparison.sources.map((source) => {
      const url = source.url.startsWith("/") ? `https://hunk.dev${source.url}` : source.url;
      return `- [${source.label}](${url})`;
    }),
    "",
    "## Other comparisons",
    "",
    ...COMPARISONS.filter((entry) => entry.slug !== comparison.slug).map(
      (entry) => `- [${entry.headline}](${comparisonUrl(entry)}) — ${entry.summary}`,
    ),
    "",
  );

  return `${lines.join("\n")}`;
}

export const GET: APIRoute = ({ props }) =>
  new Response(render(props.comparison as Comparison), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
