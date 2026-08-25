import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { UNKNOWN_CLI_VERSION } from "../run/version";

/**
 * Resolves how this Hunk binary was installed, and which package-manager client owns it.
 *
 * Both the startup update notice and `hunk update` ask the same question — "who is allowed to
 * replace this binary?" — so the answer is derived here once. Every input the detection reads
 * (environment, executable path, installed version, home directory) is injectable so tests never
 * depend on the machine they run on.
 */

const INSTALL_SOURCE_ENV = "HUNK_INSTALL_SOURCE";
const INSTALL_DIR_ENV = "HUNK_INSTALL_DIR";

/** Path segments Homebrew always puts above its binaries, on macOS and Linux alike. */
const HOMEBREW_PATH_SEGMENTS = ["cellar", "homebrew", "linuxbrew"];

export type InstallSource = "npm" | "homebrew" | "nix" | "mise" | "pacman" | "curl" | "dev";

/** Package-manager clients that can install the global `hunkdiff` npm package. */
export type NpmClient = "npm" | "bun" | "pnpm";

const INSTALL_SOURCES: readonly InstallSource[] = [
  "npm",
  "homebrew",
  "nix",
  "mise",
  "pacman",
  "curl",
  "dev",
];

export interface InstallSourceFacts {
  env?: NodeJS.ProcessEnv;
  /** Executable path to classify; defaults to the running executable. */
  executablePath?: string;
  /** Installed CLI version, used only to recognize untagged source builds. */
  version?: string;
  /** Symlink resolution for the executable path; injected so tests stay off the filesystem. */
  realpath?: (path: string) => string;
  /** Home directory used to locate the `install:bin` target; defaults to the environment's. */
  homeDir?: string;
}

/** Split one filesystem path into segments, tolerating either platform's separator. */
function splitPathSegments(candidatePath: string) {
  return candidatePath
    .split(win32.sep)
    .flatMap((segment) => segment.split(posix.sep))
    .filter((segment) => segment.length > 0);
}

/** Resolve one executable path through its symlinks, keeping the original when that fails. */
function resolveRealExecutablePath(executablePath: string, realpath?: (path: string) => string) {
  const resolve = realpath ?? ((path: string) => realpathSync.native(path));
  try {
    return resolve(executablePath);
  } catch {
    // A path we cannot stat still classifies on its literal segments.
    return executablePath;
  }
}

/**
 * Return whether this executable lives inside a mise-managed install directory.
 *
 * mise lays every backend out as `<data dir>/mise/installs/<tool>/<version>/<bin>` on all
 * platforms, so the adjacent `mise/installs` segments are the one signal that survives `mise x`
 * (the omarchy wrapper's launch path, which sets none of mise's shell env vars) as well as shims
 * and activated shells.
 */
function isMiseManagedExecutablePath(executablePath: string) {
  const segments = splitPathSegments(executablePath);
  return segments.some(
    (segment, index) => segment === "mise" && segments[index + 1] === "installs",
  );
}

/**
 * Return whether this executable came from the `hunk.dev/install.sh` curl installer.
 *
 * The installer owns a single tree — `~/.hunk`, with the binary at `~/.hunk/bin/hunk` and the
 * bundled skills beside it — and writes no environment variable, so the adjacent `.hunk`/`bin`
 * segments are the only signal, read the same way mise's layout is. Adjacency matters: a checkout
 * that keeps review artifacts in a repo-local `.hunk/` directory is not a curl install.
 */
function isCurlInstalledExecutablePath(executablePath: string) {
  const segments = splitPathSegments(executablePath);
  return segments.some((segment, index) => segment === ".hunk" && segments[index + 1] === "bin");
}

/** Executable names the Homebrew formula installs, lowercased and without a Windows suffix. */
const HOMEBREW_ARTIFACT_NAMES = ["hunk", "hunkdiff"];

/**
 * Return whether this executable is the Homebrew-installed Hunk binary.
 *
 * Homebrew sets no environment variable of its own, so the real path is the only signal: formula
 * binaries live under `<prefix>/Cellar/<formula>/<version>/bin`, reached through `/opt/homebrew`,
 * `/usr/local`, or `/home/linuxbrew/.linuxbrew`. The prefix alone is not enough — `bun run` from a
 * source checkout reports a Homebrew-installed Bun's own path, so the executable must also be named
 * like the formula's artifact. A `node_modules` segment vetoes the match, because a
 * Homebrew-installed Node keeps its global npm packages — Hunk among them — inside that same
 * prefix, and those are npm's to replace, not brew's.
 */
function isHomebrewExecutablePath(executablePath: string) {
  const segments = splitPathSegments(executablePath).map((segment) => segment.toLowerCase());
  if (segments.includes("node_modules")) {
    return false;
  }

  const executableName = segments.at(-1)?.replace(/\.exe$/, "");
  if (!executableName || !HOMEBREW_ARTIFACT_NAMES.includes(executableName)) {
    return false;
  }

  return segments.some((segment) => HOMEBREW_PATH_SEGMENTS.includes(segment));
}

/**
 * Resolve the directory `bun run install:bin` copies local builds into.
 *
 * Mirrors `scripts/install-bin.ts`: an explicit `HUNK_INSTALL_DIR` wins, Windows installs land in
 * the per-user Programs directory, and everything else uses `~/.local/bin`.
 */
export function resolveDevInstallDir(env: NodeJS.ProcessEnv, homeDir: string | undefined) {
  const configured = env[INSTALL_DIR_ENV];
  if (configured) {
    return configured;
  }

  if (process.platform === "win32") {
    const base =
      env.LOCALAPPDATA ?? (homeDir ? win32.join(homeDir, "AppData", "Local") : undefined);
    return base ? win32.join(base, "Programs", "hunk") : undefined;
  }

  return homeDir ? posix.join(homeDir, ".local", "bin") : undefined;
}

/** Return whether one path sits inside one directory, comparing the way the platform does. */
function isInsideDirectory(candidatePath: string, directory: string | undefined) {
  if (!directory) {
    return false;
  }

  const normalize = (value: string) => {
    const segments = splitPathSegments(value);
    return process.platform === "win32"
      ? segments.map((segment) => segment.toLowerCase())
      : segments;
  };

  const directorySegments = normalize(directory);
  if (directorySegments.length === 0) {
    return false;
  }

  const candidateSegments = normalize(candidatePath);
  return directorySegments.every((segment, index) => candidateSegments[index] === segment);
}

/** Read one explicitly declared install source, ignoring values Hunk does not know. */
function readDeclaredInstallSource(env: NodeJS.ProcessEnv): InstallSource | undefined {
  const declared = env[INSTALL_SOURCE_ENV];
  return INSTALL_SOURCES.find((source) => source === declared);
}

/**
 * Resolve which package manager installed this binary, defaulting to the npm package path.
 *
 * Ordering is strongest-signal first: an explicit declaration (the Nix wrapper sets one), then
 * store and install-directory layouts that only one manager produces, and finally local source
 * builds, which are recognized either by their install directory or by an untagged version.
 */
export function detectInstallSource(facts: InstallSourceFacts = {}): InstallSource {
  const env = facts.env ?? process.env;
  const declared = readDeclaredInstallSource(env);
  if (declared) {
    return declared;
  }

  const executablePath = resolveRealExecutablePath(
    facts.executablePath ?? process.execPath,
    facts.realpath,
  );

  if (executablePath.startsWith("/nix/store/")) {
    return "nix";
  }

  if (isMiseManagedExecutablePath(executablePath)) {
    return "mise";
  }

  if (isHomebrewExecutablePath(executablePath)) {
    return "homebrew";
  }

  if (isCurlInstalledExecutablePath(executablePath)) {
    return "curl";
  }

  // Boundary: a curl install redirected elsewhere with `HUNK_INSTALL_DIR` is only recognizable
  // while that variable is still exported — it names the directory `bun run install:bin` also
  // writes to, so the match below classifies it as `dev`, which safely prints a rerun command.
  // Once the installing shell exits the variable is gone, the custom directory matches nothing,
  // and detection falls through to `npm`; the installer therefore ends a custom-directory run by
  // telling the user to update by re-running it with the same `HUNK_INSTALL_DIR`.
  const homeDir = facts.homeDir ?? env.HOME ?? env.USERPROFILE;
  if (isInsideDirectory(executablePath, resolveDevInstallDir(env, homeDir))) {
    return "dev";
  }

  if ((facts.version ?? "") === UNKNOWN_CLI_VERSION) {
    return "dev";
  }

  return "npm";
}

/**
 * Resolve which client should install the global npm package.
 *
 * Global installs are owned by whichever client wrote them: a `bun i -g` install lives under
 * `.bun`, a pnpm install under a `pnpm` directory, and everything else is npm's. Reinstalling with
 * the wrong client leaves the old binary first on `PATH`, so the executable's own path picks.
 */
export function detectNpmClient(executablePath = process.execPath): NpmClient {
  const segments = splitPathSegments(executablePath).map((segment) => segment.toLowerCase());
  if (segments.includes(".bun")) {
    return "bun";
  }

  if (segments.includes("pnpm")) {
    return "pnpm";
  }

  return "npm";
}
