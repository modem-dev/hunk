import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseReviewPageAssetManifest,
  REVIEW_PAGE_DOCUMENT_NAME,
  REVIEW_PAGE_MANIFEST_NAME,
} from "../../packages/hunk/src/session/broker/reviewPageAssets";

/** Published directory, relative to a package root, that holds the browser review page build. */
export const PACKED_WEB_ASSET_DIR = "dist/npm/web";

/**
 * Lists every page file a package must publish, read from the manifest the build wrote.
 *
 * Throws when the build is absent or its manifest is unreadable, so a pack made without
 * `build-web.ts` fails here rather than shipping a daemon whose page answers 503.
 */
export function requiredWebAssetPackPaths(packageRoot: string) {
  const manifestPath = path.join(packageRoot, PACKED_WEB_ASSET_DIR, REVIEW_PAGE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Expected the browser review page build at ${manifestPath}. Run the npm build first.`,
    );
  }

  const manifest = parseReviewPageAssetManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!manifest || manifest.assets.length === 0) {
    throw new Error(`The browser review page manifest at ${manifestPath} is not valid.`);
  }

  return [REVIEW_PAGE_MANIFEST_NAME, REVIEW_PAGE_DOCUMENT_NAME, ...manifest.assets].map(
    (name) => `${PACKED_WEB_ASSET_DIR}/${name}`,
  );
}
