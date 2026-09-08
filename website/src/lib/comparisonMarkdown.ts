import {
  COMPARISONS,
  COMPARISONS_REVIEWED_ON,
  HUNK_FACTS,
  SUPPORT_MARKS,
  comparisonUrl,
  type Comparison,
  type Support,
} from "../data/comparisons";
import { SITE_ORIGIN } from "./site";

/**
 * Render one comparison as the Markdown served at its URL plus `.md`.
 *
 * The docs already publish Markdown through starlight-dot-md and robots.txt
 * tells answer engines to prefer it over scraping HTML; these pages are
 * hand-built Astro, so they need their own renderer to keep that promise. It
 * lives here rather than in the endpoint because it is a pure function of the
 * catalog, which is what makes it testable and keeps Astro's types out of any
 * program that only wants the text.
 */

/** Markdown table cell for one support mark, readable without the legend. */
function cell(support: Support): string {
  return SUPPORT_MARKS[support].label;
}

/**
 * Escape one catalog string for a Markdown table cell.
 *
 * `|` would split the cell, and `<` would let a future entry smuggle raw HTML
 * into a renderer that allows it. The catalog is hand-written today and grows
 * without anyone re-reading this function.
 */
function tableText(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("<", "&lt;");
}

export function renderComparisonMarkdown(comparison: Comparison): string {
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
    `${rival.name} is written in ${rival.language} and licensed ${rival.license}. Hunk is ${HUNK_FACTS.language}, ${HUNK_FACTS.license}, and ships as a standalone binary for ${HUNK_FACTS.platforms}.`,
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
      const url = source.url.startsWith("/") ? `${SITE_ORIGIN}${source.url}` : source.url;
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

  return lines.join("\n");
}
