import path from "node:path";

/** Repository and application paths shared by build, pack, and release tooling. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const HUNK_PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "hunk");
export const HUNK_SOURCE_ROOT = path.join(HUNK_PACKAGE_ROOT, "src");
export const HUNK_NPM_DIST = path.join(HUNK_PACKAGE_ROOT, "dist", "npm");
