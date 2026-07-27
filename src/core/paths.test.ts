import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveBundledHunkReviewSkillPath,
  resolveCanonicalPath,
  resolveGlobalConfigPath,
  resolveHunkStatePath,
} from "./paths";

function createTempRoot(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("paths", () => {
  test("resolves XDG config and state paths", () => {
    const env = { XDG_CONFIG_HOME: join("/tmp", "xdg-home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(join("/tmp", "xdg-home", "hunk", "config.toml"));
    expect(resolveHunkStatePath(env)).toBe(join("/tmp", "xdg-home", "hunk", "state.json"));
  });

  test("falls back to HOME for config and state paths", () => {
    const env = { HOME: join("/tmp", "home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "home", ".config", "hunk", "config.toml"),
    );
    expect(resolveHunkStatePath(env)).toBe(join("/tmp", "home", ".config", "hunk", "state.json"));
  });

  test("falls back to USERPROFILE when HOME is unavailable", () => {
    const env = { USERPROFILE: join("/tmp", "windows-profile") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunk", "config.toml"),
    );
    expect(resolveHunkStatePath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunk", "state.json"),
    );
  });

  test("locates the bundled Hunk review skill from source", () => {
    const resolvedPath = resolveBundledHunkReviewSkillPath([import.meta.dir]);

    expect(resolvedPath).toEndWith(join("skills", "hunk-review", "SKILL.md"));
  });

  test("locates the bundled Hunk review skill through a nested hunkdiff package", () => {
    const tempRoot = createTempRoot("hunk-skill-path-");

    try {
      const nestedPackageRoot = join(tempRoot, "node_modules", "hunkdiff");
      const skillPath = join(nestedPackageRoot, "skills", "hunk-review", "SKILL.md");
      const fakeBinary = join(tempRoot, "node_modules", "hunkdiff-linux-x64", "bin", "hunk");

      mkdirSync(dirname(skillPath), { recursive: true });
      mkdirSync(dirname(fakeBinary), { recursive: true });
      writeFileSync(skillPath, "# skill\n");
      writeFileSync(fakeBinary, "binary\n");

      expect(resolveBundledHunkReviewSkillPath([fakeBinary])).toBe(skillPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("canonicalizes two spellings of one directory to the same path", () => {
    // Canonicalize with the same resolver the code under test uses: plain
    // realpathSync leaves Windows 8.3 short names (RUNNER~1) in place, which
    // would make the expected values non-canonical on Windows runners.
    const tempRoot = resolveCanonicalPath(createTempRoot("hunk-canonical-path-"));

    try {
      const target = join(tempRoot, "target");
      const link = join(tempRoot, "link");
      mkdirSync(target, { recursive: true });

      try {
        symlinkSync(target, link, "dir");
      } catch {
        // Some Windows environments cannot create symlinks without elevated privileges.
        return;
      }

      // The mismatch this guards against: `resolve` keeps whichever spelling it
      // was handed, so two layers can "resolve" the same directory and disagree.
      expect(resolveCanonicalPath(link)).toBe(target);
      expect(resolveCanonicalPath(join(link, "nested", "missing.txt"))).toBe(
        join(target, "nested", "missing.txt"),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
