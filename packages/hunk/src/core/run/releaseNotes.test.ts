import { describe, expect, test } from "bun:test";
import { releaseNotesUrl } from "./releaseNotes";
import { UNKNOWN_CLI_VERSION } from "./version";

describe("releaseNotesUrl", () => {
  test("addresses the GitHub release tag for a stable version", () => {
    expect(releaseNotesUrl("0.21.0")).toBe(
      "https://github.com/modem-dev/hunk/releases/tag/v0.21.0",
    );
    expect(releaseNotesUrl("0.18.2")).toBe(
      "https://github.com/modem-dev/hunk/releases/tag/v0.18.2",
    );
  });

  test("preserves the prerelease identifier in the release tag", () => {
    expect(releaseNotesUrl("0.21.0-beta.0")).toBe(
      "https://github.com/modem-dev/hunk/releases/tag/v0.21.0-beta.0",
    );
  });

  test("carries a major version into the release tag", () => {
    expect(releaseNotesUrl("1.4.0")).toBe("https://github.com/modem-dev/hunk/releases/tag/v1.4.0");
  });

  test("returns nothing for unknown or non-release version strings", () => {
    for (const version of [UNKNOWN_CLI_VERSION, "", "dev", "0.21", "v0.21.0", "0.21.0+local"]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });
});
