import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DIST_DIR = join(REPO_ROOT, "website", "dist");
const CANONICAL_ORIGIN = "https://hunk.dev";
const EDIT_PREFIX = "https://github.com/modem-dev/hunk/edit/main/";
const DOCS_HEAD_TAGS = [
  '<link rel="icon" href="/docs/favicon.svg"',
  '<meta property="og:type" content="website"',
  '<meta property="og:image" content="https://hunk.dev/og.png"',
  '<meta name="twitter:card" content="summary_large_image"',
  '<meta name="twitter:image" content="https://hunk.dev/og.png"',
] as const;
const MARKETING_HEAD_TAGS = [
  '<link rel="icon" href="/icon.png"',
  '<meta property="og:type" content="website"',
  '<meta property="og:image" content="https://hunk.dev/og.png"',
  '<meta name="twitter:card" content="summary_large_image"',
  '<meta name="twitter:image" content="https://hunk.dev/og.png"',
] as const;
/** Public files every build must ship; the link-check test builds its fixture from this. */
export const REQUIRED_ASSETS = [
  "apple-icon.png",
  "favicon.svg",
  "icon.png",
  "modem-light.svg",
  "og.png",
  "shot-catppuccin-mocha.webp",
  "shot-github-dark.webp",
  "shot-github-light.webp",
  "shot-gruvbox.webp",
  "shot-nord.webp",
  "shot-tokyo-night.webp",
  "docs/favicon.svg",
  "docs/hunk-review-skill.md",
  "pagefind/pagefind.js",
] as const;

/** Recursively collect files with one extension in deterministic order. */
function collectFiles(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path, extension) : [path];
    })
    .filter((path) => path.endsWith(extension))
    .sort();
}

/** Decode the small set of HTML entities that can appear in generated attributes. */
function decodeAttribute(value: string) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

/** Read named HTML attributes without depending on a browser DOM. */
function collectAttributes(html: string, attribute: "href" | "id" | "src") {
  const pattern = new RegExp(`\\s${attribute}=["']([^"']+)["']`, "g");
  return [...html.matchAll(pattern)].map((match) => decodeAttribute(match[1] ?? ""));
}

/** Map one site-relative URL path to its static build file. */
function outputPathForUrl(distDir: string, pathname: string) {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (decoded === "" || decoded.endsWith("/")) {
    return join(distDir, decoded, "index.html");
  }
  const direct = join(distDir, decoded);
  return existsSync(direct) ? direct : join(direct, "index.html");
}

/** Derive the canonical public URL for one generated HTML path. */
function canonicalUrlForOutput(label: string) {
  if (label === "index.html") return `${CANONICAL_ORIGIN}/`;
  return `${CANONICAL_ORIGIN}/${label.replace(/index\.html$/, "")}`;
}

/** Return metadata required for one canonical page type. */
function requiredHeadTags(label: string) {
  if (label === "index.html") return MARKETING_HEAD_TAGS;
  if (label.startsWith("docs/")) return DOCS_HEAD_TAGS;
  return [];
}

/** Validate links, anchors, metadata, edit targets, and public assets in a static website build. */
export function checkWebsiteBuild(distDir = DEFAULT_DIST_DIR) {
  const errors: string[] = [];
  const htmlPaths = collectFiles(distDir, ".html");
  const htmlByPath = new Map(htmlPaths.map((path) => [path, readFileSync(path, "utf8")]));
  const idsByPath = new Map(
    [...htmlByPath].map(([path, html]) => [path, new Set(collectAttributes(html, "id"))]),
  );
  const canonicalUrls = new Set<string>();

  for (const [htmlPath, html] of htmlByPath) {
    const label = relative(distDir, htmlPath).split(sep).join("/");
    if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${label}: missing title`);
    if (!/<meta name="description" content="[^"]+"/.test(html)) {
      errors.push(`${label}: missing meta description`);
    }

    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    if (label !== "404.html") {
      const expectedCanonical = canonicalUrlForOutput(label);
      if (canonical !== expectedCanonical) {
        errors.push(
          `${label}: expected canonical ${expectedCanonical}, found ${canonical ?? "none"}`,
        );
      } else {
        canonicalUrls.add(canonical.replace(/\/$/, ""));
      }
      for (const requiredTag of requiredHeadTags(label)) {
        if (!html.includes(requiredTag)) {
          errors.push(`${label}: missing head metadata: ${requiredTag}`);
        }
      }
    }

    const references = [
      ...collectAttributes(html, "href").map((value) => ({ attribute: "href", value })),
      ...collectAttributes(html, "src").map((value) => ({ attribute: "src", value })),
    ];
    for (const { attribute, value } of references) {
      if (value === "" || /^(data:|mailto:|tel:|javascript:)/.test(value)) continue;
      if (value.startsWith(EDIT_PREFIX)) {
        const sourcePath = resolve(REPO_ROOT, decodeURIComponent(value.slice(EDIT_PREFIX.length)));
        if (!sourcePath.startsWith(`${REPO_ROOT}${sep}`) || !existsSync(sourcePath)) {
          errors.push(`${label}: edit link target does not exist: ${value}`);
        }
        continue;
      }
      if (/^https?:\/\//.test(value) || value.startsWith("//")) continue;

      const pageUrl =
        label === "404.html"
          ? `${CANONICAL_ORIGIN}/404.html`
          : (canonical ?? `${CANONICAL_ORIGIN}/${label}`);
      const parsed = new URL(value, pageUrl);
      if (parsed.pathname.startsWith("/_vercel/")) continue;

      const targetPath = outputPathForUrl(distDir, parsed.pathname);
      if (!existsSync(targetPath)) {
        errors.push(`${label}: missing ${attribute} target: ${value}`);
        continue;
      }
      if (parsed.hash && targetPath.endsWith(".html")) {
        const targetHtml = htmlByPath.get(targetPath) ?? readFileSync(targetPath, "utf8");
        const ids = idsByPath.get(targetPath) ?? new Set(collectAttributes(targetHtml, "id"));
        const anchor = decodeURIComponent(parsed.hash.slice(1));
        if (!ids.has(anchor)) errors.push(`${label}: missing anchor ${parsed.hash} in ${value}`);
      }
    }
  }

  for (const asset of REQUIRED_ASSETS) {
    if (!existsSync(join(distDir, asset))) errors.push(`missing required public asset: ${asset}`);
  }

  const sitemapPath = join(distDir, "sitemap-0.xml");
  if (!existsSync(sitemapPath)) {
    errors.push("missing sitemap-0.xml");
  } else {
    const sitemap = readFileSync(sitemapPath, "utf8");
    for (const canonical of canonicalUrls) {
      if (
        !sitemap.includes(`<loc>${canonical}</loc>`) &&
        !sitemap.includes(`<loc>${canonical}/</loc>`)
      ) {
        errors.push(`sitemap omits canonical URL: ${canonical}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Website link check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
  return { pages: htmlPaths.length, canonicalPages: canonicalUrls.size };
}

if (import.meta.main) {
  const result = checkWebsiteBuild(process.argv[2] ? resolve(process.argv[2]!) : undefined);
  console.log(`Checked ${result.pages} HTML pages and ${result.canonicalPages} canonical routes.`);
}
