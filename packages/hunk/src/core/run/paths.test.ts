import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUNDLED_SKILL_NAMES,
  resolveBundledSkillName,
  resolveBundledSkillPath,
  resolveCanonicalPath,
  resolveGlobalConfigPath,
  resolveAppStatePath,
} from "./paths";

function createTempRoot(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("paths", () => {
  test("resolves XDG config and state paths", () => {
    const env = { XDG_CONFIG_HOME: join("/tmp", "xdg-home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(join("/tmp", "xdg-home", "hunk", "config.toml"));
    expect(resolveAppStatePath(env)).toBe(join("/tmp", "xdg-home", "hunk", "state.json"));
  });

  test("falls back to HOME for config and state paths", () => {
    const env = { HOME: join("/tmp", "home") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "home", ".config", "hunk", "config.toml"),
    );
    expect(resolveAppStatePath(env)).toBe(join("/tmp", "home", ".config", "hunk", "state.json"));
  });

  test("falls back to USERPROFILE when HOME is unavailable", () => {
    const env = { USERPROFILE: join("/tmp", "windows-profile") } as NodeJS.ProcessEnv;

    expect(resolveGlobalConfigPath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunk", "config.toml"),
    );
    expect(resolveAppStatePath(env)).toBe(
      join("/tmp", "windows-profile", ".config", "hunk", "state.json"),
    );
  });

  test("locates the bundled Hunk review skill from source by default", () => {
    const resolvedPath = resolveBundledSkillPath(undefined, [import.meta.dir]);

    expect(resolvedPath).toEndWith(join("skills", "hunk-review", "SKILL.md"));
  });

  test("locates every bundled skill from source by name", () => {
    for (const skillName of BUNDLED_SKILL_NAMES) {
      expect(resolveBundledSkillPath(skillName, [import.meta.dir])).toEndWith(
        join("skills", skillName, "SKILL.md"),
      );
    }
  });

  test("resolves bundled skill names and their short aliases", () => {
    expect(resolveBundledSkillName("hunk-extensions")).toBe("hunk-extensions");
    expect(resolveBundledSkillName("extensions")).toBe("hunk-extensions");
    expect(resolveBundledSkillName(" Review ")).toBe("hunk-review");
    expect(resolveBundledSkillName("launch-video")).toBeUndefined();
    expect(resolveBundledSkillName("")).toBeUndefined();
  });

  test("names the missing skill when one cannot be located", () => {
    const tempRoot = createTempRoot("hunk-skill-missing-");

    try {
      expect(() => resolveBundledSkillPath("hunk-extensions", [tempRoot])).toThrow(
        "Could not locate the bundled Hunk hunk-extensions skill.",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("locates a bundled skill through a nested hunkdiff package", () => {
    const tempRoot = createTempRoot("hunk-skill-path-");

    try {
      const nestedPackageRoot = join(tempRoot, "node_modules", "hunkdiff");
      const skillPath = join(nestedPackageRoot, "skills", "hunk-review", "SKILL.md");
      const fakeBinary = join(tempRoot, "node_modules", "hunkdiff-linux-x64", "bin", "hunk");

      mkdirSync(dirname(skillPath), { recursive: true });
      mkdirSync(dirname(fakeBinary), { recursive: true });
      writeFileSync(skillPath, "# skill\n");
      writeFileSync(fakeBinary, "binary\n");

      expect(resolveBundledSkillPath("hunk-review", [fakeBinary])).toBe(skillPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("prefers a staged skill beside the binary over a generic one further up", () => {
    const tempRoot = createTempRoot("hunk-skill-proximity-");

    try {
      // A source install stages its skills under `hunkdiff/` beside the executable, so a
      // reviewer with their own `skills/` directory anywhere above the bin directory must
      // not shadow it. Exhausting the generic shape to the filesystem root first did.
      const installDir = join(tempRoot, ".local", "bin");
      const installedSkill = join(installDir, "hunkdiff", "skills", "hunk-review", "SKILL.md");
      const unrelatedSkill = join(tempRoot, "skills", "hunk-review", "SKILL.md");
      const fakeBinary = join(installDir, "hunk");

      mkdirSync(dirname(installedSkill), { recursive: true });
      mkdirSync(dirname(unrelatedSkill), { recursive: true });
      writeFileSync(installedSkill, "# installed\n");
      writeFileSync(unrelatedSkill, "# unrelated\n");
      writeFileSync(fakeBinary, "binary\n");

      expect(resolveBundledSkillPath("hunk-review", [fakeBinary])).toBe(installedSkill);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("prefers the packaged layout over a generic skills directory beside it", () => {
    const tempRoot = createTempRoot("hunk-skill-specificity-");

    try {
      // Both shapes at one ancestor: the one naming Hunk explicitly is the bundled skill,
      // and the bare `skills/` sibling belongs to whatever else lives in that directory.
      const packagedSkill = join(
        tempRoot,
        "node_modules",
        "hunkdiff",
        "skills",
        "hunk-review",
        "SKILL.md",
      );
      const siblingSkill = join(tempRoot, "skills", "hunk-review", "SKILL.md");
      const fakeBinary = join(tempRoot, "hunk");

      mkdirSync(dirname(packagedSkill), { recursive: true });
      mkdirSync(dirname(siblingSkill), { recursive: true });
      writeFileSync(packagedSkill, "# packaged\n");
      writeFileSync(siblingSkill, "# sibling\n");
      writeFileSync(fakeBinary, "binary\n");

      expect(resolveBundledSkillPath("hunk-review", [fakeBinary])).toBe(packagedSkill);
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
