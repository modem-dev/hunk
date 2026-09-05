import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INSTALLED_EXTENSIONS_DIR_NAME, resolveGlobalExtensionsDir } from "../core/run/paths";
import { findProjectRootCandidate } from "../core/process/projectRoot";
import {
  normalizeExtensionPackageId,
  normalizeFallbackExtensionPackageId,
} from "./packageIdentity";
import { deriveExtensionId, type ExtensionCandidate, type ExtensionOrigin } from "./types";

/** Entry-file suffixes Hunk will import directly, in preference order. */
const EXTENSION_ENTRY_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;
const EXTENSION_INDEX_BASENAMES = EXTENSION_ENTRY_SUFFIXES.map((suffix) => `index${suffix}`);
/** `package.json` field a folder extension declares its entry files under. */
const EXTENSION_MANIFEST_FIELD = "hunk";

/**
 * One entry file discovery found, with the identity and sort position it carries.
 *
 * `sortKey` keeps a folder's entries together: every entry a manifest declares
 * sorts at the folder's own position, so a multi-entry extension stays in
 * manifest order instead of being scattered by its individual file paths.
 */
interface DiscoveredExtensionEntry {
  id: string;
  path: string;
  sortKey: string;
  package: { id: string; root: string; name?: string; version?: string };
  /** Minimum extension API version the folder's manifest declared, if any. */
  requiresApiVersion?: number;
}

/** Canonicalize an entry path while preserving a useful missing-path diagnostic. */
function canonicalExtensionPath(path: string) {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Describe one standalone entry file as its own legacy package. */
function toStandaloneEntry(path: string): DiscoveredExtensionEntry {
  const canonicalPath = canonicalExtensionPath(path);
  const id = deriveExtensionId(canonicalPath);
  return {
    id,
    path: canonicalPath,
    sortKey: canonicalPath,
    package: {
      id: normalizeFallbackExtensionPackageId(id),
      root: dirname(canonicalPath),
    },
  };
}

export interface DiscoverExtensionsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Repo root used for repo-local discovery; discovered from `cwd` when omitted. */
  repoRoot?: string;
  /** Paths from repeated `--extension` flags. */
  flagPaths?: readonly string[];
  /** Paths from the user config layer's `[extensions] paths`. */
  configPaths?: readonly string[];
  /** Paths from the repo config layer's `[extensions] paths`; trust-gated like `.hunk/extensions`. */
  repoConfigPaths?: readonly string[];
  /** Override the scanned global directory; discovery falls back to the XDG location. */
  globalExtensionsDir?: string;
  /** Package ids disabled by user-owned activation preferences. */
  disabledPackageIds?: ReadonlySet<string>;
}

/** Return whether one path exists and is a directory. */
/** Canonicalize an existing package root so symlink aliases keep one identity. */
function canonicalPackageRoot(path: string) {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string) {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Return the directory's entries sorted by name, or nothing when it is unreadable. */
function readSortedDirEntries(dir: string) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Return the index entry directly inside one folder extension, if it has one.
 *
 * Preference order follows `EXTENSION_INDEX_BASENAMES`, so a folder shipping
 * both a source and a built entry resolves to the same one everywhere.
 */
function findFolderExtensionIndex(dir: string) {
  const indexBasename = EXTENSION_INDEX_BASENAMES.find((basename) =>
    fs.existsSync(join(dir, basename)),
  );
  return indexBasename ? join(dir, indexBasename) : undefined;
}

/** What one folder extension's `package.json` manifest declares. */
interface ExtensionManifest {
  /** Canonical absolute entry paths from `hunk.extensions`, or nothing when undeclared. */
  entryPaths?: string[];
  /** Lexical absolute entry paths preserve ownership when a declaration is a symlink. */
  lexicalEntryPaths?: string[];
  /** Minimum extension API version from `hunk.apiVersion`, or nothing when undeclared. */
  requiresApiVersion?: number;
  /** Stable package identity; `hunk.packageId` overrides the npm package name. */
  packageId?: string;
  packageName?: string;
  packageVersion?: string;
}

/**
 * Read one folder extension's `package.json` manifest.
 *
 * The manifest field is `"hunk": { "extensions": ["./src/index.ts"] }`, and each
 * declared path resolves against the folder. A declared path that does not exist
 * is kept rather than filtered out, matching the posture for explicit paths: the
 * host reports it as a load issue instead of the entry silently vanishing.
 * `"hunk": { "apiVersion": 3 }` states the minimum extension API version the
 * folder needs; the host refuses to load it on an older Hunk with a clear issue
 * instead of failing partway through the factory.
 *
 * Anything that goes wrong — no `package.json`, an unreadable one, malformed
 * JSON, or a field of the wrong shape — means "no manifest", so a folder that
 * merely happens to ship a `package.json` still falls back to its index entry.
 */
function readExtensionManifest(dir: string): ExtensionManifest | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }

  if (typeof manifest !== "object" || manifest === null) {
    return undefined;
  }

  const section = (manifest as Record<string, unknown>)[EXTENSION_MANIFEST_FIELD];
  if (typeof section !== "object" || section === null) {
    return undefined;
  }

  const declared = (section as Record<string, unknown>).extensions;
  // Non-string items are skipped rather than fatal; one bad array item should
  // not cost the folder the entries it declared correctly.
  const lexicalEntryPaths = Array.isArray(declared)
    ? declared
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => resolve(dir, entry))
    : undefined;
  const entryPaths = lexicalEntryPaths?.map(canonicalExtensionPath);

  // A malformed apiVersion is ignored rather than fatal, matching the "no
  // manifest" posture for every other malformed field.
  const declaredApiVersion = (section as Record<string, unknown>).apiVersion;
  const requiresApiVersion =
    typeof declaredApiVersion === "number" &&
    Number.isInteger(declaredApiVersion) &&
    declaredApiVersion > 0
      ? declaredApiVersion
      : undefined;
  const packageName = (manifest as Record<string, unknown>).name;
  const packageVersion = (manifest as Record<string, unknown>).version;
  const declaredPackageId = normalizeExtensionPackageId(
    (section as Record<string, unknown>).packageId,
  );

  return {
    entryPaths,
    lexicalEntryPaths,
    requiresApiVersion,
    ...(declaredPackageId ? { packageId: declaredPackageId } : {}),
    ...(typeof packageName === "string" && packageName.length > 0 ? { packageName } : {}),
    ...(typeof packageVersion === "string" && packageVersion.length > 0 ? { packageVersion } : {}),
  };
}

/** Assign deterministic, distinct ids to every entry in one manifest. */
function deriveManifestEntryIds(paths: readonly string[]) {
  const baseIds = paths.map((path) => deriveExtensionId(path));
  // Reserve natural stems up front so a generated suffix cannot steal a later entry's id.
  const reservedIds = new Set(baseIds);
  const assignedIds = new Set<string>();

  return baseIds.map((baseId) => {
    if (!assignedIds.has(baseId)) {
      assignedIds.add(baseId);
      return baseId;
    }

    let suffix = 2;
    let id = `${baseId}-${suffix}`;
    while (reservedIds.has(id) || assignedIds.has(id)) {
      suffix += 1;
      id = `${baseId}-${suffix}`;
    }

    assignedIds.add(id);
    return id;
  });
}

/**
 * Resolve the entry files of one folder extension.
 *
 * A `package.json` manifest wins over the `index.*` entry-suffix fallback, and
 * may declare several entries. A manifest that declares no usable entry is treated
 * as no manifest at all, so such a folder still loads its index if it has one.
 *
 * A single-entry manifest keeps the folder's name as the extension id — the
 * same id the index fallback would produce — so `[extension.<id>]` config tables
 * stay keyed by the folder the user installed, whatever the entry file is
 * called. Multiple entries are named by file stem, with a numeric suffix when
 * stems collide so configuration and registry ownership remain unambiguous.
 *
 * Returns an empty list when the folder is not an extension at all.
 */
function resolveFolderExtensionEntries(dir: string): DiscoveredExtensionEntry[] {
  dir = canonicalPackageRoot(dir);
  const manifest = readExtensionManifest(dir);
  const manifestPaths = manifest?.entryPaths;
  /** Attach the manifest's api requirement so the host can gate before importing. */
  const withApiVersion = (entry: DiscoveredExtensionEntry): DiscoveredExtensionEntry =>
    manifest?.requiresApiVersion !== undefined
      ? { ...entry, requiresApiVersion: manifest.requiresApiVersion }
      : entry;

  const folderName = basename(dir);
  const packageIdentity = {
    id:
      manifest?.packageId ??
      normalizeExtensionPackageId(manifest?.packageName) ??
      normalizeFallbackExtensionPackageId(manifest?.packageName ?? folderName),
    root: dir,
    ...(manifest?.packageName ? { name: manifest.packageName } : {}),
    ...(manifest?.packageVersion ? { version: manifest.packageVersion } : {}),
  };

  if (manifestPaths && manifestPaths.length > 0) {
    const manifestIds = deriveManifestEntryIds(manifestPaths);
    return manifestPaths.map((path, index) =>
      withApiVersion({
        id:
          manifestPaths.length === 1 && folderName.length > 0
            ? folderName
            : (manifestIds[index] ?? deriveExtensionId(path)),
        path,
        sortKey: dir,
        package: packageIdentity,
      }),
    );
  }

  // The apiVersion requirement still applies to the index fallback: a manifest
  // may state compatibility without redeclaring the entry file.
  const folderIndex = findFolderExtensionIndex(dir);
  return folderIndex
    ? [
        withApiVersion({
          ...toStandaloneEntry(folderIndex),
          package: packageIdentity,
          sortKey: dir,
        }),
      ]
    : [];
}

/**
 * Scan one extensions directory for entry files.
 *
 * Matches `<dir>/*.{ts,tsx,js,jsx,mjs}` plus exactly one level of folder
 * extensions — either a `package.json` manifest or an `index.*` file with one
 * of those suffixes — so folder extensions can keep helper modules beside
 * their entry file without being scanned as entries themselves.
 */
function scanExtensionsDir(dir: string): DiscoveredExtensionEntry[] {
  const entries: DiscoveredExtensionEntry[] = [];

  for (const entry of readSortedDirEntries(dir)) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      entries.push(...resolveFolderExtensionEntries(entryPath));
      continue;
    }

    if (EXTENSION_ENTRY_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      entries.push(toStandaloneEntry(entryPath));
    }
  }

  return entries;
}

/**
 * Resolve one directory the way explicit paths and managed installs share.
 *
 * A directory that is itself a folder extension expands to just its declared
 * entries; anything else is a container of extensions and gets scanned. This is
 * also the shape `hunk extension install` validates a cloned repository
 * against, so "what would load" has exactly one definition.
 */
export function resolveExtensionContainerEntries(dir: string): DiscoveredExtensionEntry[] {
  const folderEntries = resolveFolderExtensionEntries(dir);
  return folderEntries.length > 0 ? folderEntries : scanExtensionsDir(dir);
}

/** Describe the stable identities and ordered entries exposed by one package/container. */
export function describeExtensionPackages(dir: string) {
  const packages = new Map<
    string,
    { id: string; name?: string; version?: string; entries: string[]; root: string }
  >();
  for (const entry of resolveExtensionContainerEntries(dir)) {
    const root = canonicalPackageRoot(entry.package.root);
    const current = packages.get(entry.package.id);
    if (current) {
      if (current.root !== root) {
        throw new Error(
          `Extension package id "${entry.package.id}" is declared by distinct package roots.`,
        );
      }
      current.entries.push(entry.id);
      continue;
    }
    packages.set(entry.package.id, {
      id: entry.package.id,
      ...(entry.package.name ? { name: entry.package.name } : {}),
      ...(entry.package.version ? { version: entry.package.version } : {}),
      entries: [entry.id],
      root,
    });
  }
  return [...packages.values()].map(({ root: _root, ...entry }) => entry);
}

/**
 * Report whether one directory deliberately publishes Hunk extension entries.
 *
 * The installer asks this before recording a clone, and it is stricter than
 * what discovery would load: only a root `hunk` manifest, a root `index.*`
 * entry, top-level entry files, or a subfolder with its own `hunk` manifest
 * count. The bare `index.*` fallback for subfolders is deliberately excluded —
 * almost every JavaScript repository has a `src/index.ts`, and accepting that
 * shape would install arbitrary repositories (a pi extension, a random
 * library) as extensions that can only fail at load time.
 */
export function directoryContainsExtensionEntries(dir: string) {
  const manifest = readExtensionManifest(dir);
  if ((manifest?.entryPaths?.length ?? 0) > 0 || findFolderExtensionIndex(dir)) {
    return true;
  }

  return readSortedDirEntries(dir).some((entry) => {
    if (entry.isDirectory()) {
      return (readExtensionManifest(join(dir, entry.name))?.entryPaths?.length ?? 0) > 0;
    }

    return EXTENSION_ENTRY_SUFFIXES.some((suffix) => entry.name.endsWith(suffix));
  });
}

/**
 * Scan the managed install root: one repository clone per subdirectory.
 *
 * Each clone resolves like an explicit directory path — as a folder extension
 * when it declares itself one, otherwise as a container of entry files — so a
 * repository shares one layout contract between `--extension <path>` during
 * development and `hunk extension install` after publishing. Non-directories
 * (the records file) are skipped.
 */
function scanInstalledExtensionsRoot(root: string): DiscoveredExtensionEntry[] {
  const entries: DiscoveredExtensionEntry[] = [];

  for (const entry of readSortedDirEntries(root)) {
    // Dot-prefixed directories are the installer's own workspace (staging
    // clones, promotion backups) and must never load as extensions.
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    entries.push(...resolveExtensionContainerEntries(join(root, entry.name)));
  }

  return entries;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Config files are hand-written and documented with `~/dev/...` paths, but TOML
 * has no shell to expand them, so `~` arrives literally. Only a bare `~` or a
 * `~/` prefix is expanded — `~user` is deliberately left alone, since resolving
 * another account's home is a shell feature Hunk has no business guessing at.
 * Both separators are accepted so a Windows config may write `~\dev\...`.
 * Exported so install-source parsing expands `~` the same single way.
 */
export function expandHomePath(path: string) {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

/** Resolve a direct entry through the nearest manifest that declares its lexical or canonical path. */
function resolveExplicitEntryOwner(lexicalPath: string, canonicalPath: string) {
  const searches = [
    { path: lexicalPath, declaredPath: lexicalPath, field: "lexicalEntryPaths" as const },
    { path: canonicalPath, declaredPath: canonicalPath, field: "entryPaths" as const },
  ];

  for (const search of searches) {
    let ownerDir = dirname(search.path);
    while (true) {
      const manifest = readExtensionManifest(ownerDir);
      if (manifest) {
        const declaredIndex = manifest[search.field]?.indexOf(search.declaredPath) ?? -1;
        if (declaredIndex >= 0) {
          return resolveFolderExtensionEntries(ownerDir)[declaredIndex];
        }
        // The nearest Hunk manifest owns the boundary. A file it does not
        // declare cannot borrow an ancestor package identity.
        break;
      }
      const parent = dirname(ownerDir);
      if (parent === ownerDir) break;
      ownerDir = parent;
    }
  }

  return undefined;
}

/**
 * Expand one explicit path into entry files.
 *
 * A directory that resolves as a folder extension — by `package.json` manifest
 * or by its own `index.*` entry file — expands to just those entries: its helper
 * modules sit beside the entry file and must not be loaded as separate
 * extensions. Only a directory that is not a folder extension is a container of
 * extensions and gets scanned. Anything else is taken as a literal entry file so
 * a mistyped path still reaches the host and is reported as a load issue rather
 * than vanishing.
 */
function expandExplicitPath(path: string, cwd: string): DiscoveredExtensionEntry[] {
  const homeExpanded = expandHomePath(path);
  const lexicalPath = isAbsolute(homeExpanded) ? resolve(homeExpanded) : resolve(cwd, homeExpanded);
  const resolvedPath = canonicalExtensionPath(lexicalPath);

  if (!isDirectory(resolvedPath)) {
    // Inspect lexical ancestry before the symlink target's ancestry: a manifest
    // may deliberately declare an entry symlink whose target lives elsewhere.
    // Both paths still resolve to canonical roots/targets for deduplication and
    // package-id collision checks.
    const owned = resolveExplicitEntryOwner(lexicalPath, resolvedPath);
    return owned ? [owned] : [toStandaloneEntry(resolvedPath)];
  }

  return resolveExtensionContainerEntries(resolvedPath);
}

/**
 * Discover extension entry files in a deterministic order.
 *
 * Groups run flag paths, user-config paths, the global directory, then
 * repo-local sources, alphabetically within each group. The first occurrence of
 * a resolved path wins, so a flag path keeps its `flag` origin (and its trust
 * exemption) even when the same file is also discovered repo-locally.
 */
export function discoverExtensions(options: DiscoverExtensionsOptions = {}): ExtensionCandidate[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? findProjectRootCandidate(cwd);
  const globalExtensionsDir = options.globalExtensionsDir ?? resolveGlobalExtensionsDir(env);

  const groups: Array<{ origin: ExtensionOrigin; entries: DiscoveredExtensionEntry[] }> = [
    {
      origin: "flag",
      entries: (options.flagPaths ?? []).flatMap((path) => expandExplicitPath(path, cwd)),
    },
    {
      origin: "config",
      entries: (options.configPaths ?? []).flatMap((path) => expandExplicitPath(path, cwd)),
    },
    {
      origin: "global",
      entries: globalExtensionsDir
        ? [
            ...scanExtensionsDir(globalExtensionsDir),
            // Managed installs live one level deeper so `hunk extension
            // install` owns a directory hand-copied extensions never collide
            // with; they load with the same global origin and trust posture.
            ...scanInstalledExtensionsRoot(
              join(globalExtensionsDir, INSTALLED_EXTENSIONS_DIR_NAME),
            ),
          ]
        : [],
    },
    {
      origin: "repo",
      entries: [
        ...(repoRoot ? scanExtensionsDir(join(repoRoot, ".hunk", "extensions")) : []),
        // Repo config contributes arbitrary paths, so treat them with the same
        // trust posture as `.hunk/extensions` rather than as user intent.
        ...(options.repoConfigPaths ?? []).flatMap((path) =>
          expandExplicitPath(path, repoRoot ?? cwd),
        ),
      ],
    },
  ];

  const candidates: ExtensionCandidate[] = [];
  const seenPaths = new Set<string>();
  const packageRoots = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const entry of group.entries) {
      const roots = packageRoots.get(entry.package.id) ?? new Set<string>();
      roots.add(canonicalPackageRoot(entry.package.root));
      packageRoots.set(entry.package.id, roots);
    }
  }
  const conflictingPackageIds = new Set(
    [...packageRoots].filter(([, roots]) => roots.size > 1).map(([id]) => id),
  );

  for (const group of groups) {
    // Sorting by `sortKey` rather than by path keeps every entry of one folder
    // extension at the folder's position, and the sort's stability preserves
    // the order a manifest declared them in.
    const sorted = [...group.entries].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    for (const entry of sorted) {
      // Activation is resolved before path/id precedence and before trust/import,
      // so disabled code cannot shadow an enabled package or prompt for trust.
      if (
        conflictingPackageIds.has(entry.package.id) ||
        options.disabledPackageIds?.has(entry.package.id) ||
        seenPaths.has(entry.path)
      ) {
        continue;
      }

      seenPaths.add(entry.path);
      candidates.push({
        id: entry.id,
        path: entry.path,
        origin: group.origin,
        package: entry.package,
        // Attached only when declared so candidate equality stays byte-stable
        // for the common manifest-less case.
        ...(entry.requiresApiVersion !== undefined
          ? { requiresApiVersion: entry.requiresApiVersion }
          : {}),
      });
    }
  }

  return candidates;
}
