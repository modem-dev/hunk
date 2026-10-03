import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseNotesUrl } from "./releaseNotes";
import { UNKNOWN_CLI_VERSION } from "./version";

const CHANGELOG_CONTENT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "website",
  "src",
  "content",
  "docs",
  "changelog",
);

describe("releaseNotesUrl", () => {
  test("addresses one stable release on its series page", () => {
    expect(releaseNotesUrl("0.21.0")).toBe("https://hunk.dev/changelog/0.21/#v0-21-0");
    expect(releaseNotesUrl("0.18.2")).toBe("https://hunk.dev/changelog/0.18/#v0-18-2");
  });

  test("keeps a prerelease on the series page of the release it leads to", () => {
    expect(releaseNotesUrl("0.21.0-beta.0")).toBe(
      "https://hunk.dev/changelog/0.21/#v0-21-0-beta-0",
    );
  });

  test("carries a major version into the series path", () => {
    expect(releaseNotesUrl("1.4.0")).toBe("https://hunk.dev/changelog/1.4/#v1-4-0");
  });

  test("returns nothing for a version with no changelog page", () => {
    // A link is only useful if it resolves. Anything that is not a normalized semver — a dev
    // build, a distro-patched string, the unknown-version sentinel — has no page to point at.
    for (const version of [UNKNOWN_CLI_VERSION, "", "dev", "0.21", "v0.21.0", "0.21.0+local"]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  test("resolves against the changelog pages the website actually publishes", () => {
    // The generated pages own the real addressing: each carries its series slug in frontmatter and
    // one anchor per release. Reading them keeps this URL builder honest even though the generator
    // lives in build tooling the shipped CLI cannot import.
    const anchorPattern = /id="(v[0-9][0-9a-z-]*)"/g;
    let checked = 0;

    for (const entry of readdirSync(CHANGELOG_CONTENT_DIR)) {
      if (!entry.endsWith(".md")) continue;

      const page = readFileSync(join(CHANGELOG_CONTENT_DIR, entry), "utf8");
      const slug = page.match(/^slug:\s*(\S+)$/m)?.[1];
      if (!slug) continue;

      for (const [, anchor] of page.matchAll(anchorPattern)) {
        if (!anchor) continue;

        // Recover the version this anchor addresses, then confirm the builder reproduces both
        // halves of the published URL from that version alone.
        const version = anchor
          .slice(1)
          .replace(/-(?=(?:beta|alpha|rc)\b)/, "@")
          .replaceAll("-", ".")
          .replace("@", "-");
        expect(releaseNotesUrl(version)).toBe(`https://hunk.dev/${slug}/#${anchor}`);
        checked += 1;
      }
    }

    // Guard the guard: a glob that silently matched nothing would prove nothing.
    expect(checked).toBeGreaterThan(20);
  });
});
