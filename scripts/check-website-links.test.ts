import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { REQUIRED_ASSETS, checkWebsiteBuild } from "./check-website-links";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Create the minimum valid unified marketing and docs output fixture. */
function createWebsiteFixture() {
  const dist = mkdtempSync(join(tmpdir(), "hunk-website-links-"));
  tempDirectories.push(dist);
  mkdirSync(join(dist, "docs", "guide"), { recursive: true });
  mkdirSync(join(dist, "extensions"), { recursive: true });
  mkdirSync(join(dist, "pagefind"), { recursive: true });
  for (const asset of REQUIRED_ASSETS) {
    const path = join(dist, asset);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "asset");
  }
  writeFileSync(join(dist, "pagefind", "pagefind.js"), "export {};\n");

  const marketingHead =
    '<link rel="icon" href="/icon.png"><meta property="og:type" content="website"><meta property="og:image" content="https://hunk.dev/og.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://hunk.dev/og.png">';
  const docsHead =
    '<link rel="icon" href="/docs/favicon.svg"><meta property="og:type" content="website"><meta property="og:image" content="https://hunk.dev/og.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://hunk.dev/og.png">';
  writeFileSync(
    join(dist, "index.html"),
    `<html><head><title>Hunk</title><meta name="description" content="Hunk"><link rel="canonical" href="https://hunk.dev/">${marketingHead}</head><body><main id="install"><a href="/docs/">Docs</a><img src="/og.png"></main></body></html>`,
  );
  // The directory publishes its own card in place of the site-wide image.
  const extensionsHead = marketingHead.replaceAll(
    "https://hunk.dev/og.png",
    "https://hunk.dev/extensions/og.png",
  );
  writeFileSync(
    join(dist, "extensions", "index.html"),
    `<html><head><title>Extensions</title><meta name="description" content="Extensions"><link rel="canonical" href="https://hunk.dev/extensions/">${extensionsHead}</head><body><a href="/docs/">Docs</a><img src="/og.png"></body></html>`,
  );
  writeFileSync(
    join(dist, "docs", "index.html"),
    `<html><head><title>Docs</title><meta name="description" content="Docs"><link rel="canonical" href="https://hunk.dev/docs/">${docsHead}</head><body id="_top"><a href="/docs/guide/#step">Guide</a><a href="/">Home</a><img src="/og.png"></body></html>`,
  );
  writeFileSync(
    join(dist, "docs", "guide", "index.html"),
    `<html><head><title>Guide</title><meta name="description" content="Guide"><link rel="canonical" href="https://hunk.dev/docs/guide/">${docsHead}</head><body><h1 id="step">Step</h1><a href="/docs/">Docs</a></body></html>`,
  );
  writeFileSync(
    join(dist, "sitemap-0.xml"),
    "<urlset><url><loc>https://hunk.dev/</loc></url><url><loc>https://hunk.dev/extensions/</loc></url><url><loc>https://hunk.dev/docs/</loc></url><url><loc>https://hunk.dev/docs/guide/</loc></url></urlset>",
  );
  return dist;
}

describe("static website link checking", () => {
  test("accepts unified marketing and docs routes, anchors, metadata, and assets", () => {
    expect(checkWebsiteBuild(createWebsiteFixture())).toEqual({ pages: 4, canonicalPages: 4 });
  });

  test("reports missing internal anchors without making network requests", () => {
    const dist = createWebsiteFixture();
    const docsPath = join(dist, "docs", "index.html");
    const html = readFileSync(docsPath, "utf8");

    writeFileSync(docsPath, html.replace("#step", "#missing"));
    expect(() => checkWebsiteBuild(dist)).toThrow("missing anchor #missing");
  });

  test("requires the extension directory to publish its own social card", () => {
    const dist = createWebsiteFixture();
    const extensionsPath = join(dist, "extensions", "index.html");
    const html = readFileSync(extensionsPath, "utf8");

    // Falling back to the site-wide image is the drift worth catching: the page
    // still looks complete, and every share of it shows the wrong card.
    writeFileSync(
      extensionsPath,
      html.replaceAll("https://hunk.dev/extensions/og.png", "https://hunk.dev/og.png"),
    );
    expect(() => checkWebsiteBuild(dist)).toThrow("missing head metadata");
  });

  test("reports canonical-route and route-specific social metadata drift", () => {
    const dist = createWebsiteFixture();
    const guidePath = join(dist, "docs", "guide", "index.html");
    const html = readFileSync(guidePath, "utf8");

    writeFileSync(
      guidePath,
      html
        .replace("https://hunk.dev/docs/guide/", "https://hunk.dev/docs/wrong/")
        .replace('<meta name="twitter:card" content="summary_large_image">', ""),
    );
    expect(() => checkWebsiteBuild(dist)).toThrow("expected canonical");
    expect(() => checkWebsiteBuild(dist)).toThrow("missing head metadata");
  });
});
