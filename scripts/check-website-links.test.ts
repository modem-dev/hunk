import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkWebsiteBuild } from "./check-website-links";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Create the minimum valid /docs static output fixture. */
function createWebsiteFixture() {
  const dist = mkdtempSync(join(tmpdir(), "hunk-website-links-"));
  tempDirectories.push(dist);
  mkdirSync(join(dist, "guide"), { recursive: true });
  mkdirSync(join(dist, "pagefind"), { recursive: true });
  for (const asset of ["favicon.svg", "og.png", "hunk-review-skill.md"]) {
    writeFileSync(join(dist, asset), "asset");
  }
  writeFileSync(join(dist, "pagefind", "pagefind.js"), "export {};");
  const socialHead =
    '<link rel="icon" href="/docs/favicon.svg"><meta property="og:type" content="website"><meta property="og:image" content="https://hunk.dev/docs/og.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://hunk.dev/docs/og.png">';
  writeFileSync(
    join(dist, "index.html"),
    `<html><head><title>Docs</title><meta name="description" content="Docs"><link rel="canonical" href="https://hunk.dev/docs/">${socialHead}</head><body id="_top"><a href="/docs/guide/#step">Guide</a><img src="/docs/og.png"></body></html>`,
  );
  writeFileSync(
    join(dist, "guide", "index.html"),
    `<html><head><title>Guide</title><meta name="description" content="Guide"><link rel="canonical" href="https://hunk.dev/docs/guide/">${socialHead}</head><body><h1 id="step">Step</h1><a href="/docs/">Home</a></body></html>`,
  );
  writeFileSync(
    join(dist, "sitemap-0.xml"),
    "<urlset><url><loc>https://hunk.dev/docs/</loc></url><url><loc>https://hunk.dev/docs/guide/</loc></url></urlset>",
  );
  return dist;
}

describe("static website link checking", () => {
  test("accepts internal routes, anchors, canonical metadata, and required assets", () => {
    expect(checkWebsiteBuild(createWebsiteFixture())).toEqual({ pages: 2, canonicalPages: 2 });
  });

  test("reports missing internal anchors without making network requests", () => {
    const dist = createWebsiteFixture();
    const indexPath = join(dist, "index.html");
    const html = readFileSync(indexPath, "utf8");

    writeFileSync(indexPath, html.replace("#step", "#missing"));
    expect(() => checkWebsiteBuild(dist)).toThrow("missing anchor #missing");
  });

  test("reports canonical-route and social metadata drift", () => {
    const dist = createWebsiteFixture();
    const guidePath = join(dist, "guide", "index.html");
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
