import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Skills Hunk ships, in the order `hunk skill path` lists them.
 *
 * A skill is bundled only if it is in `package.json`'s `files` allowlist and the
 * prebuilt artifact staging. The repository-root `skills/` directory separately holds
 * maintainer-only documents that never ship, and naming them here would resolve paths users cannot have.
 */
export const BUNDLED_SKILL_NAMES = ["hunk-review", "hunk-extensions"] as const;
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number];

/** The skill `hunk skill path` prints when the user names none. */
export const DEFAULT_BUNDLED_SKILL_NAME: BundledSkillName = "hunk-review";

/** Short aliases accepted alongside each skill's own name. */
const BUNDLED_SKILL_ALIASES: Record<string, BundledSkillName> = {
  review: "hunk-review",
  extensions: "hunk-extensions",
};

/** Resolve one user-supplied skill name, or nothing when it names no bundled skill. */
export function resolveBundledSkillName(value: string): BundledSkillName | undefined {
  const normalized = value.trim().toLowerCase();
  return (
    BUNDLED_SKILL_NAMES.find((name) => name === normalized) ?? BUNDLED_SKILL_ALIASES[normalized]
  );
}

/**
 * Canonicalize one filesystem path, resolving through existing ancestors.
 *
 * This is the single normalizer for paths Hunk compares or persists as keys.
 * The same directory can be spelled several ways on one machine — through a
 * symlinked ancestor (`/tmp` on macOS, a symlinked home on Linux), through an
 * 8.3 short name or a differently cased drive letter on Windows — and plain
 * `resolve` preserves every one of those spellings, so two layers that both
 * "resolve" a path can still disagree about whether they mean the same
 * directory. `realpathSync.native` collapses all of them to the form the OS
 * itself reports, which is also the form Git's `--show-toplevel` prints.
 *
 * A path whose leaf does not exist yet is resolved through its nearest existing
 * ancestor instead, so a missing file still cannot hide behind an intermediate
 * symlink.
 */
export function resolveCanonicalPath(path: string) {
  const absolutePath = resolve(path);
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    // Continue below so non-existent leaves still get their ancestors resolved.
  }

  const missingSegments: string[] = [];
  let current = absolutePath;

  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return absolutePath;
    }

    missingSegments.unshift(basename(current));
    current = parent;

    try {
      return resolve(fs.realpathSync.native(current), ...missingSegments);
    } catch {
      // Keep walking until we find an existing ancestor or hit the filesystem root.
    }
  }
}

/** Resolve the base config directory Hunk should use for user-scoped files. */
export function resolveUserConfigDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.XDG_CONFIG_HOME) {
    return env.XDG_CONFIG_HOME;
  }

  const home = env.HOME || env.USERPROFILE;
  if (home) {
    return join(home, ".config");
  }

  return undefined;
}

/** Resolve the global Hunk config file path from the current environment. */
export function resolveGlobalConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "config.toml") : undefined;
}

/** Resolve the persisted Hunk state file path from the current environment. */
export function resolveAppStatePath(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "state.json") : undefined;
}

/** Resolve the user-scoped directory Hunk scans for globally installed extensions. */
export function resolveGlobalExtensionsDir(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "extensions") : undefined;
}

/**
 * Directory inside the global extensions dir that `hunk extension install`
 * owns. It is not itself a folder extension, so a plain scan of the global
 * dir skips it; discovery scans its subdirectories — one per installed
 * repository — explicitly.
 */
export const INSTALLED_EXTENSIONS_DIR_NAME = "installed";

/** Resolve the managed install root for `hunk extension install`. */
export function resolveInstalledExtensionsRoot(env: NodeJS.ProcessEnv = process.env) {
  const extensionsDir = resolveGlobalExtensionsDir(env);
  return extensionsDir ? join(extensionsDir, INSTALLED_EXTENSIONS_DIR_NAME) : undefined;
}

/** Search one path and its parents for one relative child path. */
function findRelativePathFromAncestors(startPath: string, relativePath: string) {
  let current = resolve(startPath);

  try {
    if (fs.statSync(current).isFile()) {
      current = dirname(current);
    }
  } catch {
    // Treat non-existent paths as directories so ancestor walking still works in tests.
  }

  for (;;) {
    const candidate = join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/**
 * Resolve one bundled skill's path from source, npm, or prebuilt package layouts.
 *
 * Every shipped skill lives at `skills/<name>/SKILL.md` in all three layouts, so
 * the name is the only thing that varies and the search itself stays one walk.
 */
export function resolveBundledSkillPath(
  name: BundledSkillName = DEFAULT_BUNDLED_SKILL_NAME,
  searchRoots?: string[],
) {
  const roots = searchRoots ?? [import.meta.dir, process.execPath];
  const skillRelativePath = join("skills", name, "SKILL.md");
  const relativeCandidates = [
    skillRelativePath,
    join("hunkdiff", skillRelativePath),
    join("node_modules", "hunkdiff", skillRelativePath),
  ];

  for (const root of roots) {
    for (const relativePath of relativeCandidates) {
      const resolvedPath = findRelativePathFromAncestors(root, relativePath);
      if (resolvedPath) {
        return resolvedPath;
      }
    }
  }

  throw new Error(`Could not locate the bundled Hunk ${name} skill.`);
}
