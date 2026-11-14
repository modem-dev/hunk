import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentDirectoryReviewPageAssets } from "../../packages/hunk/src/session/broker/reviewPageAssets";
import { ReviewPageServer } from "../../packages/hunk/src/session/broker/reviewPageServer";
import { reviewAssetPath } from "../../packages/hunk/src/session/reviewHttpProtocol";
import { BUNDLED_SHIKI_THEME_IDS } from "../../packages/hunk/src/core/theme/catalog";
import { TERMINAL_THEME_ID } from "../../packages/hunk/src/core/theme/terminalColors";
import { THEMES } from "../../packages/hunk/src/ui/themes";
import { buildWebThemeIndex, installBuild, renderReviewPageDocument } from "./build-web";

/** Write a fake page build listing `assets` into `directory`. */
function writeTestBuild(directory: string, assets: string[]) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "index.html"), assets.join("\n"));
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ formatVersion: 1, assets }),
  );
  for (const name of assets) {
    writeFileSync(path.join(directory, name), name);
  }
}

describe("installBuild", () => {
  // Intent: a page loaded before a dev rebuild still finds its hashed assets, and only the
  // one replaced generation is kept, so the build directory does not grow.
  test("keeps the replaced build's listed assets until the next build", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hunk-build-web-"));
    const outdir = path.join(root, "web");
    const has = (name: string) => existsSync(path.join(outdir, name));

    try {
      writeTestBuild(outdir, ["main-a.js"]);
      writeFileSync(path.join(outdir, "unlisted.js"), "");
      writeTestBuild(path.join(root, "staging-b"), ["main-b.js"]);
      installBuild(path.join(root, "staging-b"), outdir);

      expect([has("main-a.js"), has("main-b.js")]).toEqual([true, true]);
      expect(has("unlisted.js")).toBe(false);

      writeTestBuild(path.join(root, "staging-c"), ["main-c.js"]);
      installBuild(path.join(root, "staging-c"), outdir);

      expect([has("main-a.js"), has("main-b.js"), has("main-c.js")]).toEqual([false, true, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Intent: the daemon serves only names a manifest records, so a kept asset must be recorded
  // to reach an open page; unknown names and the generation before it still 404.
  test("serves the replaced build's assets through the page server after a rebuild", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hunk-build-web-"));
    const outdir = path.join(root, "web");
    const server = new ReviewPageServer({
      loadAssets: async () => currentDirectoryReviewPageAssets(outdir),
    });
    const status = async (name: string) =>
      (await server.handle(new Request(`http://127.0.0.1${reviewAssetPath(name)}`)))!.status;

    try {
      writeTestBuild(outdir, ["chunk-a.js"]);
      expect(await status("chunk-a.js")).toBe(200);
      writeTestBuild(path.join(root, "staging-b"), ["chunk-b.js"]);
      installBuild(path.join(root, "staging-b"), outdir);

      expect(await status("chunk-a.js")).toBe(200);
      expect(await status("chunk-b.js")).toBe(200);
      expect(await status("chunk-unknown.js")).toBe(404);

      writeTestBuild(path.join(root, "staging-c"), ["chunk-c.js"]);
      installBuild(path.join(root, "staging-c"), outdir);
      expect(await status("chunk-a.js")).toBe(404);
      expect(await status("chunk-b.js")).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildWebThemeIndex", () => {
  // Intent: the browser gets the terminal's own resolved tokens for every built-in theme,
  // so there is no second derivation to drift, and the terminal theme is left out.
  test("carries every built-in theme's tokens as the terminal resolves them", () => {
    const index = buildWebThemeIndex();

    expect(index.themes.map((theme) => theme.id)).toEqual([...BUNDLED_SHIKI_THEME_IDS]);
    expect(index.themes.some((theme) => theme.id === TERMINAL_THEME_ID)).toBe(false);
    for (const [position, theme] of index.themes.entries()) {
      const source = THEMES[position]!;
      expect(theme.appearance).toBe(source.appearance);
      expect(theme.tokens.addedBg).toBe(source.addedBg);
      expect(theme.tokens.fileNew).toBe(source.fileNew);
      expect(Object.values(theme.tokens).every((value) => typeof value === "string")).toBe(true);
    }
  });
});

describe("renderReviewPageDocument", () => {
  test("names the theme index and loads only hashed assets", () => {
    const html = renderReviewPageDocument("main-1.js", ["main-1.css"], "themes-1.json");

    expect(html).toContain('<meta name="hunk-theme-index" content="/review-assets/themes-1.json">');
    expect(html).toContain('<script type="module" src="/review-assets/main-1.js">');
    expect(html).not.toMatch(/<script>|<style>|style="/);
  });
});
