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

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { BunPlugin } from "bun";
import {
  REVIEW_PAGE_DOCUMENT_NAME,
  REVIEW_PAGE_MANIFEST_NAME,
  reviewAssetContentType,
  type ReviewPageAssetManifestV1,
} from "../../packages/hunk/src/session/broker/reviewPageAssets";
import {
  isReviewAssetName,
  reviewAssetPath,
} from "../../packages/hunk/src/session/reviewHttpProtocol";
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

/** Render the page document that loads the entry script and its stylesheets. */
export function renderReviewPageDocument(entry: string, stylesheets: readonly string[]) {
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

/**
 * Move one finished build into place.
 *
 * The build is written to a sibling staging directory and renamed over the target, so a
 * daemon serving the previous build never sees a half-written one and two concurrent builds
 * (parallel test daemons in a source checkout) cannot interleave their files.
 */
function installBuild(staging: string, outdir: string) {
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
  rmSync(retired, { recursive: true, force: true });
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
      renderReviewPageDocument(path.basename(entry.path), stylesheets),
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
