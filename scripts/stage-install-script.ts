import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Stages the repo-root install script into the built website so hunk.dev/install.sh serves it.
 *
 * The script's canonical home is `install.sh` at the repository root — it is a product artifact
 * with its own tests and release-pipeline contract, not site content — and the website build
 * copies it into the deploy output as its final step. Runs after `astro build`, so a missing
 * dist directory means the build order is wrong and the copy must fail rather than invent one.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const SOURCE = join(REPO_ROOT, "install.sh");
const DIST_DIR = join(REPO_ROOT, "website", "dist");

if (!existsSync(SOURCE)) {
  console.error(`stage-install-script: missing ${SOURCE}`);
  process.exit(1);
}

if (!existsSync(DIST_DIR)) {
  console.error(`stage-install-script: ${DIST_DIR} does not exist; run the website build first.`);
  process.exit(1);
}

copyFileSync(SOURCE, join(DIST_DIR, "install.sh"));
console.log(`Staged install.sh into ${DIST_DIR}`);
