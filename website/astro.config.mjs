import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://hunk.dev",
  base: "/docs",
  output: "static",
  integrations: [
    sitemap(),
    starlight({
      title: "hunk",
      description:
        "Review code changes and collaborate with coding agents in a desktop-inspired terminal diff viewer.",
      logo: {
        src: "./src/assets/hunk-mark.svg",
        alt: "hunk",
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/modem-dev/hunk" }],
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/docs/favicon.svg", type: "image/svg+xml" } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:site_name", content: "Hunk documentation" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://hunk.dev/docs/og.png" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image:alt",
            content: "Hunk terminal diff review documentation",
          },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://hunk.dev/docs/og.png" } },
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
            { label: "Overview", slug: "index" },
            { label: "Install", slug: "start/install" },
            { label: "Quick start", slug: "start/quick-start" },
            { label: "Keyboard and mouse", slug: "start/keyboard-and-mouse" },
          ],
        },
        {
          label: "Review workflows",
          items: [
            { label: "Working trees and commits", slug: "workflows/working-trees-and-commits" },
            { label: "Files and patches", slug: "workflows/files-and-patches" },
            { label: "Git pager and difftool", slug: "workflows/git-pager-and-difftool" },
            { label: "Jujutsu and Sapling", slug: "workflows/jujutsu-and-sapling" },
            { label: "Watch mode", slug: "workflows/watch-mode" },
          ],
        },
        {
          label: "Working with agents",
          items: [
            { label: "Review with an agent", slug: "agents/review-with-an-agent" },
            { label: "Live session control", slug: "agents/live-session-control" },
            { label: "Comments and annotations", slug: "agents/comments-and-annotations" },
            { label: "Agent context and STML", slug: "agents/agent-context-and-stml" },
            { label: "Hunk review skill", slug: "agents/review-skill" },
          ],
        },
        {
          label: "Configure",
          items: [
            { label: "Configuration", slug: "configure/configuration" },
            { label: "Themes", slug: "configure/themes" },
            { label: "Layout and display", slug: "configure/layout-and-display" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI reference", slug: "reference/cli" },
            { label: "Config reference", slug: "reference/config" },
            { label: "OpenTUI components", slug: "reference/opentui-components" },
          ],
        },
        {
          label: "Help",
          items: [
            { label: "Troubleshooting", slug: "help/troubleshooting" },
            { label: "Terminal and platform compatibility", slug: "help/compatibility" },
            { label: "Deployment integration", slug: "help/deployment" },
          ],
        },
      ],
    }),
  ],
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
      wrap: true,
    },
  },
});
