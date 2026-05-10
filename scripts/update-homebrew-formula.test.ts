import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ASSETS = [
  "hunkdiff-darwin-arm64.tar.gz",
  "hunkdiff-darwin-x64.tar.gz",
  "hunkdiff-linux-arm64.tar.gz",
  "hunkdiff-linux-x64.tar.gz",
] as const;

/** Create minimal release asset placeholders for formula checksum generation. */
function createTestAssets(assetRoot: string) {
  for (const asset of ASSETS) {
    writeFileSync(path.join(assetRoot, asset), `contents for ${asset}`);
  }
}

describe("update-homebrew-formula", () => {
  test("writes a formula that installs the binary through the Homebrew update-notice wrapper", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hunk-homebrew-formula-"));
    const assetRoot = path.join(root, "assets");
    const outputRoot = path.join(root, "tap");

    try {
      mkdirSync(assetRoot, { recursive: true });
      createTestAssets(assetRoot);
      const proc = Bun.spawnSync(
        [
          "bun",
          "run",
          path.resolve(import.meta.dir, "update-homebrew-formula.ts"),
          "--tag",
          "v1.2.3",
          "--asset-root",
          assetRoot,
          "--output-root",
          outputRoot,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      expect(proc.exitCode).toBe(0);
      const formula = readFileSync(path.join(outputRoot, "Formula", "hunk.rb"), "utf8");
      expect(formula).toContain('version "1.2.3"');
      expect(formula).toContain("hunkdiff-darwin-arm64.tar.gz");
      expect(formula).toContain("hunkdiff-linux-x64.tar.gz");
      expect(formula).toContain('chmod 0755, "hunk"');
      expect(formula).toContain('libexec.install "hunk"');
      expect(formula).toContain(
        '(bin/"hunk").write_env_script libexec/"hunk", HUNK_INSTALL_SOURCE: "homebrew"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
