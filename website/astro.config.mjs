import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://hunk.dev",
  output: "static",
  integrations: [
    sitemap(),
    starlight({
      title: "hunk",
      description:
        "Review code changes and collaborate with coding agents in a desktop-inspired terminal diff viewer.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/modem-dev/hunk" }],
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/docs/favicon.svg", type: "image/svg+xml" } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:site_name", content: "Hunk documentation" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://hunk.dev/og.png" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "Hunk terminal diff review documentation",
          },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://hunk.dev/og.png" } },
        {
          tag: "script",
          content:
            'document.addEventListener("DOMContentLoaded",()=>document.querySelectorAll("pre").forEach((block)=>{if(block.scrollWidth>block.clientWidth||block.scrollHeight>block.clientHeight)block.setAttribute("tabindex","0")}));',
        },
      ],
      editLink: {
        baseUrl: "https://github.com/modem-dev/hunk/edit/main/website/",
      },
      lastUpdated: true,
      pagination: true,
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "docs" },
            { label: "Install", slug: "docs/start/install" },
            { label: "Quick start", slug: "docs/start/quick-start" },
            { label: "Keyboard and mouse", slug: "docs/start/keyboard-and-mouse" },
          ],
        },
        {
          label: "Review workflows",
          items: [
            {
              label: "Working trees and commits",
              slug: "docs/workflows/working-trees-and-commits",
            },
            { label: "Files and patches", slug: "docs/workflows/files-and-patches" },
            { label: "Git pager and difftool", slug: "docs/workflows/git-pager-and-difftool" },
            { label: "Jujutsu and Sapling", slug: "docs/workflows/jujutsu-and-sapling" },
            { label: "Watch mode", slug: "docs/workflows/watch-mode" },
          ],
        },
        {
          label: "Working with agents",
          items: [
            { label: "Review with an agent", slug: "docs/agents/review-with-an-agent" },
            { label: "Live session control", slug: "docs/agents/live-session-control" },
            { label: "Comments and annotations", slug: "docs/agents/comments-and-annotations" },
            { label: "Agent context and STML", slug: "docs/agents/agent-context-and-stml" },
            { label: "Hunk review skill", slug: "docs/agents/review-skill" },
          ],
        },
        {
          label: "Configure",
          items: [
            { label: "Configuration", slug: "docs/configure/configuration" },
            { label: "Themes", slug: "docs/configure/themes" },
            { label: "Layout and display", slug: "docs/configure/layout-and-display" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI reference", slug: "docs/reference/cli" },
            { label: "Config reference", slug: "docs/reference/config" },
            { label: "OpenTUI components", slug: "docs/reference/opentui-components" },
          ],
        },
        {
          label: "Help",
          items: [
            { label: "Troubleshooting", slug: "docs/help/troubleshooting" },
            { label: "Terminal and platform compatibility", slug: "docs/help/compatibility" },
            { label: "Deployment integration", slug: "docs/help/deployment" },
          ],
        },
      ],
    }),
  ],
  markdown: {
    // CLI prose is full of `--flags`; smart typography would corrupt them into en/em dashes.
    smartypants: false,
    shikiConfig: {
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
      wrap: true,
    },
  },
});
