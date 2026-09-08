import type { APIRoute, GetStaticPaths } from "astro";
import { VCS_LANDING_PAGES, type VcsLandingPage } from "../data/vcsLandingPages";
import { renderVcsLandingMarkdown } from "../lib/vcsLandingMarkdown";

/** Serves each VCS workflow guide as Markdown beside its HTML page. */
export const getStaticPaths: GetStaticPaths = () =>
  VCS_LANDING_PAGES.map((page) => ({ params: { vcs: page.slug }, props: { page } }));

export const GET: APIRoute = ({ props }) =>
  new Response(renderVcsLandingMarkdown(props.page as VcsLandingPage), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
