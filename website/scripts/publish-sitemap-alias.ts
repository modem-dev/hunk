import { copyFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = join(import.meta.dirname, "..", "dist");

/** Publishes the generated URL set at the conventional sitemap.xml path. */
async function publishSitemapAlias(): Promise<void> {
  await copyFile(join(outputDirectory, "sitemap-0.xml"), join(outputDirectory, "sitemap.xml"));
}

await publishSitemapAlias();
