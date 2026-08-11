import { createHash } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CliInput } from "./types";

/** Name of hunk's repo-local metadata directory. */
export const HUNK_DIR_NAME = ".hunk";
/**
 * Legacy bare agent-context filename.
 *
 * Still valid as an *explicit* or config path. Auto-discovery never uses this
 * name alone — see `conventionalAgentContextPath` and SPEC REQ-AGENT-001.
 */
export const AGENT_CONTEXT_FILENAME = "agent-context.json";
/** Hex length of the review-target id embedded in the conventional sidecar name. */
export const AGENT_CONTEXT_TARGET_ID_LENGTH = 12;
/** Conventional per-repo review-state filename inside `.hunk/`. */
export const REVIEW_STATE_FILENAME = "review-state.json";
/**
 * Conventional per-repo review-comment filename inside `.hunk/`.
 *
 * Separate from `REVIEW_STATE_FILENAME` on purpose: viewed state is derived and resets on
 * any doubt, while comments are authored and are never discarded. One file cannot carry
 * both policies.
 */
export const REVIEW_COMMENTS_FILENAME = "review-comments.json";
/**
 * Conventional per-repo review-focus filename inside `.hunk/`.
 *
 * Where an agent points its human partner. Derived like `REVIEW_STATE_FILENAME` and unlike
 * `REVIEW_COMMENTS_FILENAME`: a corrupt focus resets to none, because nothing here is
 * authored — it says what to look at, never what is true about the code.
 */
export const REVIEW_FOCUS_FILENAME = "review-focus.json";

/**
 * Skills Hunk ships, in the order `hunk skill path` lists them.
 *
 * A skill is bundled only if it is in `package.json`'s `files` allowlist and the
 * prebuilt artifact staging; `skills/` also holds maintainer-only documents that
 * never ship, and naming them here would resolve paths users cannot have.
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

/** Return whether a repo-root-relative path lives inside hunk's `.hunk/` metadata dir. */
export function isHunkMetadataRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized === HUNK_DIR_NAME || normalized.startsWith(`${HUNK_DIR_NAME}/`);
}

/**
 * Normalize pathspecs the way discovery hashes them: trim, drop empties, sort.
 *
 * Sorting is required so `-- path/a path/b` and `-- path/b path/a` name one sidecar.
 */
export function normalizeAgentContextPathspecs(pathspecs: readonly string[] | undefined): string[] {
  if (!pathspecs || pathspecs.length === 0) {
    return [];
  }

  return [...pathspecs]
    .map((pathspec) => pathspec.trim())
    .filter((pathspec) => pathspec.length > 0)
    .sort();
}

/**
 * Canonical string for the review target a CLI invocation asked for.
 *
 * Intent only — kind, expression/ref, and pathspecs — never resolved commit SHAs and never
 * patch bytes. Same string for the same human command; branch tips may move without
 * renaming the sidecar (matching review-focus target policy).
 *
 * Returns null for non-repo inputs (file/patch/difftool): those never auto-discover.
 */
export function canonicalizeAgentContextTarget(input: CliInput): string | null {
  const pathspecs = normalizeAgentContextPathspecs(
    "pathspecs" in input ? input.pathspecs : undefined,
  );
  const pathspecKey = pathspecs.join("\0");

  if (input.kind === "vcs") {
    if (input.staged) {
      return ["staged", pathspecKey].join("\0");
    }
    if (input.range !== undefined && input.range.length > 0) {
      return ["range", input.range, pathspecKey].join("\0");
    }
    return ["working-tree", pathspecKey].join("\0");
  }

  if (input.kind === "show") {
    return ["show", input.ref ?? "", pathspecKey].join("\0");
  }

  if (input.kind === "stash-show") {
    return ["stash-show", input.ref ?? ""].join("\0");
  }

  return null;
}

/**
 * Short stable id for one review target, embedded in the conventional sidecar filename.
 *
 * Users never type this; Hunk derives it from the same CLI args that open the review.
 */
export function agentContextTargetId(input: CliInput): string | null {
  const canonical = canonicalizeAgentContextTarget(input);
  if (canonical === null) {
    return null;
  }

  return createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, AGENT_CONTEXT_TARGET_ID_LENGTH);
}

/**
 * Absolute path of the conventional auto-discovery sidecar for this review target.
 *
 * Form: `<repoRoot>/.hunk/agent-context.<targetId>.json`. Null when the input is not a
 * repo-backed review target (no auto-discovery).
 */
export function conventionalAgentContextPath(repoRoot: string, input: CliInput): string | null {
  const targetId = agentContextTargetId(input);
  if (targetId === null) {
    return null;
  }

  return join(repoRoot, HUNK_DIR_NAME, `agent-context.${targetId}.json`);
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
export function resolveHunkStatePath(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "state.json") : undefined;
}

/** Resolve the user-scoped directory Hunk scans for globally installed extensions. */
export function resolveGlobalExtensionsDir(env: NodeJS.ProcessEnv = process.env) {
  const configDir = resolveUserConfigDir(env);
  return configDir ? join(configDir, "hunk", "extensions") : undefined;
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
