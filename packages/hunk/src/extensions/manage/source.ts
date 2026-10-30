import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { expandHomePath } from "../discovery";
import { EXTENSION_ID_RULE, isValidExtensionId } from "../extensionIds";

/** Describe a Git install, including local checkouts cloned into managed storage.
 * Keep the repository name as its directory and single-entry extension ID.
 */
export interface GitExtensionInstallSource {
  kind: "git";
  /** The spec exactly as the user typed it, kept for records and messages. */
  spec: string;
  /** URL (or local path) handed to `git clone`. */
  cloneUrl: string;
  /** Branch, tag, or commit requested with an `@ref` suffix, if any. */
  ref?: string;
  /** Repository name; the install directory and extension id namespace. */
  name: string;
}

/** Describe a registry package independently of the version currently installed. */
export interface NpmExtensionInstallSource {
  kind: "npm";
  spec: string;
  packageName: string;
  selector?: string;
  /** Stable filesystem-safe install name, independent of the version selector. */
  name: string;
}

export type ExtensionInstallSource = GitExtensionInstallSource | NpmExtensionInstallSource;

/** Derive a bounded, scoped-package-safe identity without losing punctuation distinctions. */
export function npmInstallName(packageName: string) {
  const readable = packageName
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);
  return `npm-${readable}-${createHash("sha256").update(packageName).digest("hex")}`;
}

/** Parse registry package names and selectors without admitting URLs or local package specs. */
function parseNpmSource(spec: string): NpmExtensionInstallSource {
  const match = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@]+))?$/.exec(spec);
  const packageName = match?.[1];
  const selector = match?.[2];
  if (
    !packageName ||
    packageName.length > 214 ||
    (selector !== undefined &&
      (!/^[a-zA-Z0-9.*^~<>=|+ _!()'-]+$/.test(selector) || selector.trim() !== selector))
  ) {
    throw new Error(
      `Invalid npm install source "${spec}". Use npm:package, npm:@scope/package, or append @version, @range, or @tag.`,
    );
  }

  return {
    kind: "npm",
    spec,
    packageName,
    ...(selector !== undefined ? { selector } : {}),
    name: npmInstallName(packageName),
  };
}

/** Match `owner/repo` shorthand: exactly two path segments, no scheme or host. */
const GITHUB_SHORTHAND_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Return whether one location already names a transport git understands. */
function hasExplicitTransport(location: string) {
  return (
    /^(https?|ssh|git|file):\/\//.test(location) ||
    // scp-like syntax: user@host:path
    /^[^/@]+@[^/:]+:/.test(location)
  );
}

/** Return whether one location is a local filesystem path. */
function isLocalPath(location: string) {
  // Both separators for the relative forms, so Windows `.\dev\ext` works too.
  return (
    isAbsolute(location) ||
    location.startsWith("./") ||
    location.startsWith("../") ||
    location.startsWith(".\\") ||
    location.startsWith("..\\") ||
    location.startsWith("~")
  );
}

/** Index of the last path separator, counting both `/` and Windows `\`. */
function lastSeparatorIndex(location: string) {
  return Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"));
}

/**
 * Split one `@ref` suffix off a location.
 *
 * Only an `@` after the last `/` is a ref separator, so scp-like
 * `git@github.com:owner/repo` and userinfo in URLs stay untouched.
 */
function splitRefSuffix(location: string): { location: string; ref?: string } {
  const atIndex = location.lastIndexOf("@");
  if (atIndex <= 0 || atIndex < lastSeparatorIndex(location)) {
    return { location };
  }

  const ref = location.slice(atIndex + 1);
  if (ref.length === 0) {
    throw new Error(`Install source "${location}" has an empty ref after "@".`);
  }

  return { location: location.slice(0, atIndex), ref };
}

/** Derive the repository name from one clone location. */
function deriveRepositoryName(location: string) {
  const trimmed = location.replace(/[/\\]+$/, "");
  // scp-like locations separate the path with ":", URLs and POSIX paths with
  // "/", and Windows local paths with "\" (their drive colon splits too, which
  // is fine — the repository name is always the last segment).
  const lastSegment = trimmed.split(/[/\\:]/).at(-1) ?? "";
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
}

/**
 * Parse one install source into its Git or npm acquisition inputs.
 *
 * Accepted forms, in the spirit of `pi install git:...` and
 * `herdr plugin install owner/repo`:
 *
 * - `owner/repo` — GitHub shorthand
 * - `git:github.com/owner/repo` — pi-style, `https://` is assumed
 * - `https://...`, `ssh://...`, `git@host:path` — passed to git verbatim
 * - a local path — mostly useful for testing an extension before publishing
 *
 * Git forms take an optional `@ref` suffix naming a branch, tag, or commit.
 * `npm:package` and `npm:@scope/package` take optional versions, ranges, or tags.
 */
export function parseExtensionInstallSource(spec: string): ExtensionInstallSource {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error("Install source must not be empty.");
  }

  if (trimmed.startsWith("npm:")) {
    return parseNpmSource(trimmed);
  }

  // `git:` marks "the rest is a clone location"; it is a spec prefix, not a
  // scheme, so `git://host/path` (with slashes) stays a transport URL.
  const explicitGit = trimmed.startsWith("git:") && !trimmed.startsWith("git://");
  const { location, ref } = splitRefSuffix(explicitGit ? trimmed.slice(4) : trimmed);
  if (location.length === 0) {
    throw new Error(`Install source "${spec}" names no repository.`);
  }

  let cloneUrl: string;
  if (hasExplicitTransport(location)) {
    cloneUrl = location;
  } else if (isLocalPath(location)) {
    // Git never expands `~` itself, and the record must survive a later
    // `update` run from a different working directory, so local paths are
    // stored home-expanded and absolute.
    cloneUrl = resolve(expandHomePath(location));
  } else if (!explicitGit && GITHUB_SHORTHAND_PATTERN.test(location)) {
    cloneUrl = `https://github.com/${location}`;
  } else if (location.includes("/")) {
    // `git:github.com/owner/repo` and friends: a bare host/path location.
    cloneUrl = `https://${location}`;
  } else {
    throw new Error(
      `Install source "${spec}" is not a repository. Use owner/repo, git:host/path, a git URL, or a local path.`,
    );
  }

  const name = deriveRepositoryName(location);
  if (name.length === 0) {
    throw new Error(`Install source "${spec}" names no repository.`);
  }

  if (!isValidExtensionId(name)) {
    throw new Error(
      `Repository name "${name}" cannot be an extension id — ${EXTENSION_ID_RULE}. Rename the repository or install it manually.`,
    );
  }

  return ref !== undefined
    ? { kind: "git", spec: trimmed, cloneUrl, ref, name }
    : { kind: "git", spec: trimmed, cloneUrl, name };
}
