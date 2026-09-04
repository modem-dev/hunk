import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import starlightDotMd from "starlight-dot-md";
import starlightLlmsTxt from "starlight-llms-txt";

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
      plugins: [
        // Serves every docs page's Markdown source at the same URL plus `.md`, so a
        // hunk.dev link pasted into an agent resolves to clean Markdown instead of
        // HTML that has to be converted back. Complements the llms.txt corpus below:
        // that is for learning Hunk, this is for reading one page.
        starlightDotMd(),
        // Publishes /llms.txt, /llms-small.txt, and /llms-full.txt so coding agents can
        // pull Hunk's docs directly instead of scraping rendered HTML. The full corpus is
        // small enough (~130KB of Markdown) that an agent can fetch llms-full.txt in one go.
        starlightLlmsTxt({
          projectName: "Hunk",
          description:
            "Hunk is a terminal-first diff viewer for reviewing complete changesets and keeping coding-agent rationale beside the code it explains.",
          // Keep this to durable, agent-specific rules only. Anything restated from a docs
          // page (install commands, flags, defaults) is a hand-maintained copy that goes
          // stale silently, and the generated body below already carries those pages.
          details: [
            "## Notes for agents",
            "",
            "- Hunk's TUI is for the human operator. Do NOT launch `hunk diff`, `hunk show`, or other interactive commands yourself.",
            "- To inspect or drive a review the user already has open, use the `hunk session *` commands, which talk to the local daemon.",
            "- The agent-facing workflow is documented under 'Working with agents'; the installable skill is published at https://hunk.dev/docs/hunk-review-skill.md.",
          ].join("\n"),
          optionalLinks: [
            {
              label: "Hunk review skill",
              url: "https://hunk.dev/docs/hunk-review-skill.md",
              description: "Drop-in agent skill for driving a live Hunk review session.",
            },
            {
              label: "Hunk compared with other diff tools",
              url: "https://hunk.dev/compare/",
              description:
                "Head-to-head pages for delta, difftastic, diff-so-fancy, git diff, and Plannotator. Each is also served as Markdown at the same URL plus `.md`.",
            },
            {
              label: "Hunk changelog",
              url: "https://hunk.dev/changelog/",
              description: "Every release, grouped by minor series, with per-version change lists.",
            },
            {
              label: "GitHub repository",
              url: "https://github.com/modem-dev/hunk",
              description: "Source, issues, and changelog.",
            },
          ],
          // Heading anchor links serialize as "Section titled ..." noise in every page.
          // The object form is required: a bare array would only apply to llms-small.txt.
          customSelectors: { all: ["a.sl-anchor-link"] },
          // Lead with the overview and onboarding pages rather than alphabetical order.
          promote: ["docs", "docs/start/**"],
          // Extension authoring is a niche, code-heavy slice of the docs, and the changelog is
          // long and grows every release. Both stay in llms-full.txt — which is what answers
          // "which version added X" — but drop out of the context-constrained variant.
          exclude: ["docs/extend/**", "docs/reference/opentui-components", "changelog/**"],
        }),
      ],
      head: [
        {
          tag: "script",
          attrs: { defer: true, src: "/_vercel/insights/script.js" },
        },
        { tag: "link", attrs: { rel: "icon", href: "/docs/favicon.svg", type: "image/svg+xml" } },
        { tag: "meta", attrs: { property: "og:type", content: "website" } },
        { tag: "meta", attrs: { property: "og:site_name", content: "Hunk documentation" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://hunk.dev/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
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
      components: {
        Footer: "./src/components/docs/DocsFooter.astro",
        Head: "./src/components/docs/DocsHead.astro",
        Header: "./src/components/docs/DocsHeader.astro",
        MarkdownContent: "./src/components/docs/DocsMarkdownContent.astro",
        MobileMenuFooter: "./src/components/docs/DocsMobileMenuFooter.astro",
        Sidebar: "./src/components/docs/DocsSidebar.astro",
        ThemeProvider: "./src/components/docs/LightThemeProvider.astro",
      },
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
            { label: "Repository history", slug: "docs/workflows/git-history" },
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
            { label: "Keybindings", slug: "docs/configure/keybindings" },
          ],
        },
        {
          label: "Extend",
          items: [
            { label: "Extensions", slug: "docs/extend/extensions" },
            { label: "Extension API", slug: "docs/extend/extension-api" },
            { label: "File previews", slug: "docs/extend/file-previews" },
            { label: "VCS adapters", slug: "docs/extend/vcs-adapters" },
            { label: "Custom sidebars", slug: "docs/extend/custom-sidebars" },
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
        // One link rather than a group: the changelog is generated, grows every release, and
        // carries its own series navigation, so listing 19 versions here would bury the docs.
        { label: "Changelog", link: "/changelog/" },
        // The comparison cluster lives outside the docs but answers a docs-shaped question
        // ("should I be using this instead of delta?"), so it gets one link rather than a page.
        { label: "Compare with other tools", link: "/compare/" },
      ],
    }),
  ],
  markdown: {
    // CLI prose is full of `--flags`; smart typography would corrupt them into en/em dashes.
    processor: unified({ smartypants: false }),
    shikiConfig: {
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
      wrap: true,
    },
  },
});
