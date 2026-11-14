#!/usr/bin/env bun

/**
 * Builds the browser review client into a self-contained static page.
 *
 * Bundles `packages/hunk/src/web/main.tsx` for browsers into content-hashed, code-split
 * files, writes the `index.html` that loads them from the daemon's shared asset prefix, and
 * records every servable file in `manifest.json`. Syntax grammars and themes stay separate
 * lazy chunks because Pierre loads them through dynamic imports, so a page fetches only the
 * languages it shows.
 *
 * Every distribution goes through `buildWebAssets`: `bun run build:web` and the source-run
 * fallback write `packages/hunk/dist/web`, `build-npm.ts` writes `dist/npm/web`, and
 * `build-bin.ts` packs the output into the archive the binary embeds. Output is generated
 * and never committed.
 *
 * Options:
 *   --outdir <path>  Write the build here instead of `packages/hunk/dist/web`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import type { BunPlugin } from "bun";
import {
  REVIEW_PAGE_DOCUMENT_NAME,
  REVIEW_PAGE_MANIFEST_NAME,
  parseReviewPageAssetManifest,
  reviewAssetContentType,
  type ReviewPageAssetManifestV1,
} from "../../packages/hunk/src/session/broker/reviewPageAssets";
import {
  isReviewAssetName,
  reviewAssetPath,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
import { THEMES } from "../../packages/hunk/src/ui/themes";
import {
  WEB_THEME_INDEX_META_NAME,
  type WebThemeIndexV1,
} from "../../packages/hunk/src/web/theme/themeIndex";
import { HUNK_PACKAGE_ROOT, HUNK_SOURCE_ROOT } from "./package-paths";

/** Entry module of the browser client. */
export const WEB_ENTRYPOINT = path.join(HUNK_SOURCE_ROOT, "web", "main.tsx");

/** Where a source checkout keeps its page build; `reviewPageAssets.ts` reads it from here. */
export const SOURCE_WEB_OUTDIR = path.join(HUNK_PACKAGE_ROOT, "dist", "web");

/**
 * Keeps Shiki's Oniguruma WASM engine out of the page.
 *
 * Pierre highlights with Shiki's JavaScript regex engine unless a caller asks for WASM, and
 * the page never does. Leaving the dynamic `shiki/wasm` import unresolved would still ship a
 * 460 KB binary and make the policy decision for `'wasm-unsafe-eval'` someone else's; stubbing
 * it keeps both out, and a caller that did ask would get a clear error instead.
 */
const omitShikiWasm: BunPlugin = {
  name: "hunk-omit-shiki-wasm",
  setup(build) {
    build.onResolve({ filter: /^shiki\/wasm$/ }, () => ({
      path: "shiki-wasm-omitted",
      namespace: "hunk-web-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "hunk-web-stub" }, () => ({
      contents:
        'throw new Error("The Hunk browser client does not bundle the Oniguruma WASM engine.");',
      loader: "js",
    }));
  },
};

/**
 * Build the browser theme index from the terminal's own theme derivation.
 *
 * `ui/themes.ts` is not browser-safe, so the page cannot run it; instead every built-in theme
 * is resolved here, at build time, by the same code the terminal runs, and the page receives
 * the finished tokens. There is no second derivation to drift. The `terminal` theme follows
 * a terminal's palette and has no browser meaning, so it is not in `THEMES`.
 */
export function buildWebThemeIndex(): WebThemeIndexV1 {
  return {
    formatVersion: 1,
    themes: THEMES.map((theme) => ({
      id: theme.id,
      label: theme.label,
      appearance: theme.appearance,
      syntaxTheme: theme.syntaxTheme ?? theme.id,
      tokens: Object.fromEntries(
        Object.entries(theme).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            !["id", "label", "appearance", "syntaxTheme"].includes(entry[0]),
        ),
      ),
    })),
  };
}

/** Write the theme index under a content-hashed name and return that name. */
function writeWebThemeIndex(directory: string) {
  const text = `${JSON.stringify(buildWebThemeIndex())}\n`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const name = `themes-${hash}.json`;
  writeFileSync(path.join(directory, name), text);
  return name;
}

/** Render the page document that loads the entry script and its stylesheets. */
export function renderReviewPageDocument(
  entry: string,
  stylesheets: readonly string[],
  themeIndex?: string,
) {
  // The document is identical for every session and carries no data: the script reads the
  // session from the path and the capability from the fragment.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>Hunk review</title>",
    ...(themeIndex
      ? [`<meta name="${WEB_THEME_INDEX_META_NAME}" content="${reviewAssetPath(themeIndex)}">`]
      : []),
    ...stylesheets.map((name) => `<link rel="stylesheet" href="${reviewAssetPath(name)}">`),
    `<script type="module" src="${reviewAssetPath(entry)}"></script>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Return the asset names one build directory's manifest lists, or none when it has none. */
function listedAssets(directory: string): string[] {
  try {
    const manifest = parseReviewPageAssetManifest(
      JSON.parse(readFileSync(path.join(directory, REVIEW_PAGE_MANIFEST_NAME), "utf8")),
    );
    return manifest?.assets ?? [];
  } catch {
    return [];
  }
}

/**
 * Move one finished build into place.
 *
 * The build is written to a sibling staging directory and renamed over the target, so a
 * daemon serving the previous build never sees a half-written one and two concurrent builds
 * (parallel test daemons in a source checkout) cannot interleave their files.
 *
 * The replaced build's hashed assets stay beside the new one until the next build, recorded
 * in the new manifest's `retained` list (the server serves only recorded names), so a page
 * loaded before a source-checkout rebuild still finds its lazy chunks and stylesheets. Only
 * that one generation is kept, so the directory does not grow; packaged installs never
 * rebuild in place.
 *
 * Between the two renames the directory is briefly absent, and the manifest is rewritten
 * after the swap to record what was kept. A daemon reading during either moment finds no
 * manifest or an older one, never a partial one, and keeps serving the last build it read
 * (`currentDirectoryReviewPageAssets`).
 */
export function installBuild(staging: string, outdir: string) {
  const retired = `${outdir}.retired-${process.pid}-${Date.now()}`;
  if (existsSync(outdir)) {
    renameSync(outdir, retired);
  }
  try {
    renameSync(staging, outdir);
  } catch (error) {
    // Another build installed between the two renames; its output is equivalent.
    if (!existsSync(path.join(outdir, REVIEW_PAGE_MANIFEST_NAME))) {
      throw error;
    }
    rmSync(staging, { recursive: true, force: true });
  }

  const manifestPath = path.join(outdir, REVIEW_PAGE_MANIFEST_NAME);
  const manifest = parseReviewPageAssetManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const own = new Set(manifest?.assets ?? []);
  const retained: string[] = [];
  for (const name of listedAssets(retired)) {
    if (own.has(name)) continue;
    try {
      renameSync(path.join(retired, name), path.join(outdir, name));
      retained.push(name);
    } catch {
      // An asset that cannot be kept costs only a page already open its lazy chunks.
    }
  }
  rmSync(retired, { recursive: true, force: true });
  // The server serves only names a manifest records, so the kept ones are recorded too.
  if (manifest) {
    writeFileReplacing(manifestPath, `${JSON.stringify({ ...manifest, retained })}\n`);
  }
}

/**
 * Replace one file of a live build in a single rename.
 *
 * A daemon reads the manifest on every asset lookup, so rewriting it in place could hand that
 * read a truncated file. The new content goes to a temporary sibling (same directory, same
 * filesystem) and is renamed over the target, so a reader sees the old file or the new one.
 */
function writeFileReplacing(target: string, content: string) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}-${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export interface BuildWebAssetsOptions {
  outdir?: string;
}

/** Build the browser client into `outdir` and return its manifest. */
export async function buildWebAssets({
  outdir = SOURCE_WEB_OUTDIR,
}: BuildWebAssetsOptions = {}): Promise<ReviewPageAssetManifestV1> {
  const staging = `${outdir}.staging-${process.pid}-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const result = await Bun.build({
      entrypoints: [WEB_ENTRYPOINT],
      outdir: staging,
      target: "browser",
      format: "esm",
      splitting: true,
      minify: true,
      sourcemap: "none",
      naming: {
        entry: "[name]-[hash].[ext]",
        chunk: "[name]-[hash].[ext]",
        asset: "[name]-[hash].[ext]",
      },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [omitShikiWasm],
    });
    if (!result.success) {
      throw new AggregateError(result.logs, "The browser client failed to build.");
    }

    const themeIndex = writeWebThemeIndex(staging);
    const names = readdirSync(staging).sort();
    for (const name of names) {
      // The daemon serves only names the page grammar accepts with a known content type, so
      // anything else would be a file the page references and the daemon refuses to serve.
      if (!isReviewAssetName(name) || reviewAssetContentType(name) === undefined) {
        throw new Error(`The browser client build emitted an unservable file: ${name}`);
      }
    }

    const entry = result.outputs.find((output) => output.kind === "entry-point");
    if (!entry) {
      throw new Error("The browser client build emitted no entry script.");
    }
    const stylesheets = names.filter((name) => name.endsWith(".css"));
    writeFileSync(
      path.join(staging, REVIEW_PAGE_DOCUMENT_NAME),
      renderReviewPageDocument(path.basename(entry.path), stylesheets, themeIndex),
    );

    const manifest: ReviewPageAssetManifestV1 = { formatVersion: 1, assets: names };
    writeFileSync(
      path.join(staging, REVIEW_PAGE_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    mkdirSync(path.dirname(outdir), { recursive: true });
    installBuild(staging, outdir);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { outdir: { type: "string" } },
    strict: true,
  });
  const outdir = values.outdir ? path.resolve(values.outdir) : SOURCE_WEB_OUTDIR;
  const manifest = await buildWebAssets({ outdir });
  console.log(`Built ${outdir} (${manifest.assets.length} assets)`);
}
