import type { APIRoute, GetStaticPaths } from "astro";
import { COMPARISONS, type Comparison } from "../../data/comparisons";
import { renderComparisonMarkdown } from "../../lib/comparisonMarkdown";

/**
 * Serves every comparison as Markdown at its own URL plus `.md`.
 *
 * The rendering lives in `lib/comparisonMarkdown`; this file is the Astro glue
 * that maps a slug onto it.
 */
export const getStaticPaths: GetStaticPaths = () =>
  COMPARISONS.map((comparison) => ({
    params: { slug: comparison.slug },
    props: { comparison },
  }));

// The build is static, so this header only applies under `astro dev`; the deployed
// files are served with whatever the host infers from the `.md` extension.
export const GET: APIRoute = ({ props }) =>
  new Response(renderComparisonMarkdown(props.comparison as Comparison), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
