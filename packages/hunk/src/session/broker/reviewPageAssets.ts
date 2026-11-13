/**
 * Finds the built browser review page for the daemon to serve, in whichever form this Hunk
 * distribution carries it.
 *
 * The page is a static client built by `scripts/build/build-web.ts`: one `index.html`, a set
 * of content-hashed scripts and styles, and a `manifest.json` naming every asset. Each
 * distribution carries that build differently, and this module is what lets the daemon not
 * care which one it is running in:
 *
 * - The compiled binary embeds one archive (`hunk-web-assets.bin`) holding every file
 *   gzip-compressed, so the executable stays one file and grows by the compressed size.
 * - The npm package ships the build as plain files in `dist/npm/web`, beside `main.js`.
 * - A source checkout serves `packages/hunk/dist/web`, and runs the build script once when
 *   that output is missing, so `bun run packages/hunk/src/main.tsx` works with no manual
 *   step. An existing build is reused as-is; rerun `bun run build:web` after changing the
 *   client.
 *
 * Nothing here decides how a response looks — headers, caching, and methods belong to
 * `reviewPageServer.ts`. Lookups go through the manifest only, so a request can name an
 * asset but never a path: there is no way to reach a file the build did not list.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isReviewAssetName } from "../reviewHttpProtocol";

/** File name of the page document inside one build. */
export const REVIEW_PAGE_DOCUMENT_NAME = "index.html";

/** File name of the asset manifest inside one build. */
export const REVIEW_PAGE_MANIFEST_NAME = "manifest.json";

/**
 * Base name of the archive the compiled binary embeds.
 *
 * Bun appends a content hash when it embeds a file, so the runtime matches this stem rather
 * than the exact name.
 */
export const REVIEW_PAGE_ARCHIVE_STEM = "hunk-web-assets";

/** Extension of the embedded archive; not one Bun bundles as code, so it embeds verbatim. */
export const REVIEW_PAGE_ARCHIVE_EXTENSION = ".bin";

const ARCHIVE_MAGIC = new TextEncoder().encode("HUNKWEB1");

/**
 * Content type each asset extension is served as.
 *
 * Closed on purpose: the build refuses to emit a file whose type is not listed, so the
 * daemon never serves something a browser would have to sniff.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Content type the page document is served as. */
export const REVIEW_PAGE_DOCUMENT_CONTENT_TYPE = "text/html; charset=utf-8";

/** Return the content type one asset name is served as, or nothing for an unknown kind. */
export function reviewAssetContentType(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : ASSET_CONTENT_TYPES[name.slice(dot)];
}

/** The list of assets one page build contains, as `manifest.json` records it. */
export interface ReviewPageAssetManifestV1 {
  formatVersion: 1;
  /** Every servable asset except the document, in build output order. */
  assets: string[];
}

/** Parse one manifest, refusing any asset name the page grammar would not serve. */
export function parseReviewPageAssetManifest(
  value: unknown,
): ReviewPageAssetManifestV1 | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== 1 || !Array.isArray(record.assets)) {
    return undefined;
  }
  const assets = record.assets;
  const valid = assets.every(
    (name) => isReviewAssetName(name) && reviewAssetContentType(name) !== undefined,
  );
  return valid ? { formatVersion: 1, assets: assets as string[] } : undefined;
}

/** One servable file: its bytes, how they are typed, and whether they are stored gzipped. */
export interface ReviewPageFile {
  body: Blob;
  contentType: string;
  /** True when `body` is the gzip encoding of the file rather than the file itself. */
  gzip: boolean;
}

/** One loaded page build. */
export interface ReviewPageAssets {
  /** The page document, identical for every session. */
  document(): ReviewPageFile;
  /** One listed asset, or nothing for a name the build does not contain. */
  asset(name: string): ReviewPageFile | undefined;
}

/** Serve one build directory, reading each file lazily from disk. */
export function directoryReviewPageAssets(directory: string): ReviewPageAssets | undefined {
  const manifestPath = join(directory, REVIEW_PAGE_MANIFEST_NAME);
  if (!existsSync(manifestPath) || !existsSync(join(directory, REVIEW_PAGE_DOCUMENT_NAME))) {
    return undefined;
  }

  let manifest: ReviewPageAssetManifestV1 | undefined;
  try {
    manifest = parseReviewPageAssetManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    manifest = undefined;
  }
  if (!manifest) {
    return undefined;
  }

  const listed = new Set(manifest.assets);
  return {
    document: () => ({
      body: Bun.file(join(directory, REVIEW_PAGE_DOCUMENT_NAME)),
      contentType: REVIEW_PAGE_DOCUMENT_CONTENT_TYPE,
      gzip: false,
    }),
    asset: (name) =>
      listed.has(name)
        ? {
            body: Bun.file(join(directory, name)),
            contentType: reviewAssetContentType(name)!,
            gzip: false,
          }
        : undefined,
  };
}

/** Where each archived file's gzip bytes sit, relative to the start of the payload. */
interface ReviewPageArchiveHeader {
  manifest: ReviewPageAssetManifestV1;
  entries: Record<string, [offset: number, length: number]>;
}

/**
 * Pack one build into the archive the compiled binary embeds.
 *
 * Layout: an 8-byte magic, a little-endian u32 header length, a JSON header mapping each
 * file name to its offset and length in the payload, then every file gzip-compressed. Files
 * stay compressed at rest and on the wire, so the daemon never inflates the build into memory
 * to serve it.
 */
export function encodeReviewPageAssetArchive(
  manifest: ReviewPageAssetManifestV1,
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Uint8Array<ArrayBuffer> {
  const names = [REVIEW_PAGE_DOCUMENT_NAME, ...manifest.assets];
  const compressed = names.map((name) => {
    const bytes = files.get(name);
    if (!bytes) {
      throw new Error(`The page build is missing ${name}.`);
    }
    return Bun.gzipSync(bytes, { level: 9 });
  });

  const entries: ReviewPageArchiveHeader["entries"] = {};
  let offset = 0;
  names.forEach((name, index) => {
    entries[name] = [offset, compressed[index]!.byteLength];
    offset += compressed[index]!.byteLength;
  });

  const header = new TextEncoder().encode(
    JSON.stringify({ manifest, entries } satisfies ReviewPageArchiveHeader),
  );
  const archive = new Uint8Array(ARCHIVE_MAGIC.byteLength + 4 + header.byteLength + offset);
  archive.set(ARCHIVE_MAGIC, 0);
  new DataView(archive.buffer).setUint32(ARCHIVE_MAGIC.byteLength, header.byteLength, true);
  archive.set(header, ARCHIVE_MAGIC.byteLength + 4);
  let cursor = ARCHIVE_MAGIC.byteLength + 4 + header.byteLength;
  for (const bytes of compressed) {
    archive.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  return archive;
}

/** Parse one archive's header and serve its files as slices of the archive blob. */
export async function archiveReviewPageAssets(
  archive: Blob,
): Promise<ReviewPageAssets | undefined> {
  const prefixLength = ARCHIVE_MAGIC.byteLength + 4;
  if (archive.size < prefixLength) {
    return undefined;
  }
  const prefix = new Uint8Array(await archive.slice(0, prefixLength).arrayBuffer());
  if (!ARCHIVE_MAGIC.every((byte, index) => prefix[index] === byte)) {
    return undefined;
  }
  const headerLength = new DataView(prefix.buffer).getUint32(ARCHIVE_MAGIC.byteLength, true);
  const payloadStart = prefixLength + headerLength;
  if (payloadStart > archive.size) {
    return undefined;
  }

  let header: ReviewPageArchiveHeader;
  try {
    header = JSON.parse(await archive.slice(prefixLength, payloadStart).text());
  } catch {
    return undefined;
  }
  const manifest = parseReviewPageAssetManifest(header.manifest);
  if (!manifest || typeof header.entries !== "object" || header.entries === null) {
    return undefined;
  }

  /** Slice one archived file, refusing an entry that points outside the archive. */
  const slice = (name: string): Blob | undefined => {
    const entry = Object.hasOwn(header.entries, name) ? header.entries[name] : undefined;
    if (
      !Array.isArray(entry) ||
      !Number.isSafeInteger(entry[0]) ||
      !Number.isSafeInteger(entry[1]) ||
      entry[0] < 0 ||
      entry[1] < 0 ||
      payloadStart + entry[0] + entry[1] > archive.size
    ) {
      return undefined;
    }
    return archive.slice(payloadStart + entry[0], payloadStart + entry[0] + entry[1]);
  };

  const document = slice(REVIEW_PAGE_DOCUMENT_NAME);
  if (!document || manifest.assets.some((name) => slice(name) === undefined)) {
    return undefined;
  }

  const listed = new Set(manifest.assets);
  return {
    document: () => ({
      body: document,
      contentType: REVIEW_PAGE_DOCUMENT_CONTENT_TYPE,
      gzip: true,
    }),
    asset: (name) =>
      listed.has(name)
        ? { body: slice(name)!, contentType: reviewAssetContentType(name)!, gzip: true }
        : undefined,
  };
}

/** Find the archive `bun build --compile` embedded, when this process is the compiled binary. */
function embeddedArchive(): Blob | undefined {
  const pattern = new RegExp(
    `^${REVIEW_PAGE_ARCHIVE_STEM}(?:-[a-z0-9]+)?\\${REVIEW_PAGE_ARCHIVE_EXTENSION}$`,
  );
  return Bun.embeddedFiles.find((file) =>
    pattern.test((file as Blob & { name?: string }).name ?? ""),
  );
}

/**
 * The source-checkout layout, when this module is running as TypeScript from the repo.
 *
 * A bundle (`dist/npm/main.js`, the compiled binary) is never `.ts`, so this cannot
 * misfire in an installed copy and point at a directory outside the package.
 */
function sourceLayout() {
  if (!/\.tsx?$/.test(import.meta.path)) {
    return undefined;
  }
  const packageRoot = resolve(import.meta.dir, "..", "..", "..");
  const buildScript = resolve(packageRoot, "..", "..", "scripts", "build", "build-web.ts");
  return existsSync(buildScript)
    ? { outdir: join(packageRoot, "dist", "web"), buildScript }
    : undefined;
}

/** Run the repository's page build once, reporting whether it succeeded. */
async function buildSourceAssets(buildScript: string): Promise<boolean> {
  const build = Bun.spawn([process.execPath, buildScript], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  return (await build.exited) === 0;
}

let embedded: Promise<ReviewPageAssets | undefined> | undefined;
let sourceBuild: Promise<boolean> | undefined;
const directoryCache = new Map<string, { mtimeMs: number; assets: ReviewPageAssets }>();

/**
 * Serve one build directory, re-reading its manifest only when the build was replaced.
 *
 * `build-web.ts` swaps a whole new directory into place, so a changed manifest timestamp is
 * the signal that a running daemon must stop serving the previous build's names.
 */
function currentDirectoryAssets(directory: string): ReviewPageAssets | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(join(directory, REVIEW_PAGE_MANIFEST_NAME)).mtimeMs;
  } catch {
    directoryCache.delete(directory);
    return undefined;
  }
  const cached = directoryCache.get(directory);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.assets;
  }
  const assets = directoryReviewPageAssets(directory);
  if (assets) {
    directoryCache.set(directory, { mtimeMs, assets });
  }
  return assets;
}

/**
 * Load the page build this distribution carries, building it first in a source checkout.
 *
 * The embedded archive is read once. A build directory is checked on every call so a rebuild
 * while the daemon runs is picked up. A source build is single-flight, and a failed one is
 * retried by the next page request rather than leaving the daemon without a page.
 */
export async function loadReviewPageAssets(): Promise<ReviewPageAssets | undefined> {
  const archive = embeddedArchive();
  if (archive) {
    embedded ??= archiveReviewPageAssets(archive);
    return embedded;
  }

  // The npm bundle runs from `dist/npm/main.js`, with the build beside it in `dist/npm/web`.
  const packaged = currentDirectoryAssets(join(import.meta.dir, "web"));
  if (packaged) {
    return packaged;
  }

  const source = sourceLayout();
  if (!source) {
    return undefined;
  }
  const existing = currentDirectoryAssets(source.outdir);
  if (existing) {
    return existing;
  }
  sourceBuild ??= buildSourceAssets(source.buildScript).finally(() => {
    sourceBuild = undefined;
  });
  return (await sourceBuild) ? currentDirectoryAssets(source.outdir) : undefined;
}
