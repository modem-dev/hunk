import { HunkUserError } from "../run/errors";
import { detectInstallSource, detectNpmClient, type InstallSource } from "./installSource";
import { fetchChannelVersions, type FetchImpl } from "./latestRelease";
import { isComparableVersion, isNewerVersion, resolveCliVersion } from "../run/version";

/**
 * Runs `hunk update`: replaces this Hunk install with a published release, or explains who can.
 *
 * The install source decides everything. npm, Homebrew, and curl-installer installs are replaced in
 * place by re-running whatever owns them; Nix, mise, and local source builds are owned by something
 * Hunk must not run behind the user's back, so those print the one command that does work and stop.
 * Every input the command reads or writes — environment, executable path, network, child processes,
 * output streams — arrives through `SelfUpdateIo` so tests drive it offline.
 */

const NPM_PACKAGE_NAME = "hunkdiff";
const HOMEBREW_FORMULA_NAME = "hunk";
const CURL_INSTALL_SCRIPT_URL = "https://hunk.dev/install.sh";
const CURL_INSTALL_VERSION_ENV = "HUNK_VERSION";

/** Install sources `hunk update` can replace on its own. */
const SELF_UPDATABLE_SOURCES: readonly InstallSource[] = ["npm", "homebrew", "curl"];

/** Install methods `--method` accepts, keyed by the spelling users type. */
const UPDATE_METHOD_ALIASES: Record<string, InstallSource> = {
  npm: "npm",
  brew: "homebrew",
  homebrew: "homebrew",
  curl: "curl",
};

/** Accepted `--method` values, in the order the help and error messages list them. */
export const UPDATE_METHOD_VALUES = ["npm", "brew", "curl"] as const;

/** Join accepted values into the "`a`, `b`, and `c`" phrasing the error messages use. */
function listUpdateMethods() {
  const quoted = UPDATE_METHOD_VALUES.map((name) => `\`${name}\``);
  if (quoted.length < 3) {
    return quoted.join(" and ");
  }

  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

export interface SelfUpdateInput {
  /** Version to install; the channel's newest release when omitted. */
  version?: string;
  /** Install method override from `--method`, already normalized. */
  method?: InstallSource;
  /** Report the installed and available versions without installing anything. */
  check: boolean;
}

/** Outcome of one package-manager invocation. */
export interface SelfUpdateProcessResult {
  exitCode: number;
  stderr: string;
}

/** Extra spawn settings one update command needs beyond its argv. */
export interface SelfUpdateCommandOptions {
  /** Full environment for the child; the parent's own environment when omitted. */
  env?: NodeJS.ProcessEnv;
}

export interface SelfUpdateIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  /** Platform used to pick package-manager executable names; defaults to the running platform. */
  platform?: NodeJS.Platform;
  resolveInstalledVersion?: () => string;
  resolveInstallSource?: () => InstallSource;
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  runCommand?: (
    command: readonly string[],
    options?: SelfUpdateCommandOptions,
  ) => Promise<SelfUpdateProcessResult>;
}

/** Normalize one `--method` value, or explain which values exist. */
export function parseUpdateMethod(value: string): InstallSource {
  const method = UPDATE_METHOD_ALIASES[value.toLowerCase()];
  if (!method) {
    throw new HunkUserError(`Unknown update method: ${value}`, [
      `Supported methods are ${listUpdateMethods()}.`,
    ]);
  }

  return method;
}

/** Validate one requested version, or explain what the argument accepts. */
export function parseUpdateVersion(value: string): string {
  // Release tags spell versions as `v1.2.3`, so tolerate that prefix before validating.
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!isComparableVersion(version)) {
    throw new HunkUserError(`Invalid version: ${value}`, [
      "Pass an exact release version such as `0.19.0`.",
    ]);
  }

  return version;
}

/** Name one install source the way the user would say it. */
function describeInstallSource(installSource: InstallSource) {
  if (installSource === "homebrew") {
    return "Homebrew";
  }

  if (installSource === "nix") {
    return "Nix";
  }

  if (installSource === "dev") {
    return "a local source build";
  }

  if (installSource === "curl") {
    return "the install script";
  }

  return installSource;
}

/** Build the install command for one npm-published target version. */
function npmUpdateCommand(
  executablePath: string,
  targetVersion: string,
  platform: NodeJS.Platform,
) {
  const spec = `${NPM_PACKAGE_NAME}@${targetVersion}`;
  const client = detectNpmClient(executablePath);
  if (client === "bun") {
    return ["bun", "add", "--global", spec];
  }

  // npm and pnpm ship as `.cmd` batch shims on Windows, and `Bun.spawn` runs its argv directly
  // without PATHEXT resolution, so the shim must be named explicitly there.
  const shim = (name: string) => (platform === "win32" ? `${name}.cmd` : name);
  if (client === "pnpm") {
    return [shim("pnpm"), "add", "--global", spec];
  }

  return [shim("npm"), "install", "--global", spec];
}

/**
 * Build the command that re-runs the curl installer for one target version.
 *
 * The installer is the updater: it already resolves the platform archive, verifies its checksum,
 * and swaps the tree in place, so duplicating any of that here would give curl installs a second
 * download path that can drift from the one users pipe into `sh`. The script downloads to a file
 * before executing — piping it straight into `sh` would report the pipeline's last status, so a
 * failed fetch would feed `sh` empty input and read as a successful update. wget stands in when
 * curl is absent, since the installer itself supports wget-only machines. The target version
 * travels in the child environment, where the installer reads `HUNK_VERSION`.
 */
function curlUpdateCommand() {
  const script = [
    "set -e",
    'tmp="$(mktemp)"',
    "trap 'rm -f \"$tmp\"' EXIT",
    `if command -v curl >/dev/null 2>&1; then curl -fsSL ${CURL_INSTALL_SCRIPT_URL} -o "$tmp"; else wget -qO "$tmp" ${CURL_INSTALL_SCRIPT_URL}; fi`,
    'sh "$tmp"',
  ].join("; ");
  return ["sh", "-c", script];
}

/** Choose the command that installs one target version for the channel that owns this binary. */
function buildUpdateCommand(
  installSource: InstallSource,
  executablePath: string,
  targetVersion: string,
  platform: NodeJS.Platform,
) {
  if (installSource === "homebrew") {
    return ["brew", "upgrade", HOMEBREW_FORMULA_NAME];
  }

  if (installSource === "curl") {
    return curlUpdateCommand();
  }

  return npmUpdateCommand(executablePath, targetVersion, platform);
}

/** Spawn one package-manager command, streaming its output and capturing stderr for failures. */
async function spawnUpdateCommand(
  command: readonly string[],
  options: SelfUpdateCommandOptions = {},
): Promise<SelfUpdateProcessResult> {
  const [executable] = command;
  try {
    const child = Bun.spawn({
      cmd: [...command],
      env: options.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    return { exitCode, stderr };
  } catch (error) {
    throw new HunkUserError(
      `Could not run ${executable}: ${error instanceof Error ? error.message : String(error)}`,
      [`Updating this install needs \`${executable}\` on PATH.`],
    );
  }
}

/** Name the registry a failed release lookup was asking, so the error says where it stalled. */
function describeFetchFailure(installSource: InstallSource) {
  if (installSource === "homebrew") {
    return "Could not read the latest Hunk version from the Homebrew formula API.";
  }

  if (installSource === "curl") {
    return "Could not read the latest Hunk version from the GitHub releases API.";
  }

  return "Could not read the latest Hunk version from the npm registry.";
}

/** Guidance lines for an install source Hunk must not update itself. */
function unmanagedInstallGuidance(installSource: InstallSource) {
  if (installSource === "nix") {
    return [
      "Hunk was installed with Nix.",
      "Update it through your Nix configuration, then rebuild that profile or flake.",
    ];
  }

  if (installSource === "mise") {
    return ["Hunk was installed with mise.", "Run `mise up hunk` to update it."];
  }

  if (installSource === "pacman") {
    return ["Hunk was installed with pacman.", "Update it through pacman or your AUR helper."];
  }

  return [
    "Hunk is running from a local source build.",
    "Run `bun run install:bin` in your Hunk checkout to update it.",
  ];
}

/** Print the guidance for an install source Hunk must not update itself. */
function reportUnmanagedInstall(
  installSource: InstallSource,
  installedVersion: string,
  input: SelfUpdateInput,
  io: SelfUpdateIo,
) {
  const guidance = unmanagedInstallGuidance(installSource);

  io.stdout(`hunk ${installedVersion} (installed with ${describeInstallSource(installSource)})\n`);
  io.stdout(`${guidance.join("\n")}\n`);
  // `--check` only reports, so it succeeds; an explicit update request did not happen and says so.
  return input.check ? 0 : 1;
}

/**
 * Run one `hunk update` invocation and return its exit code.
 *
 * Returns 0 when Hunk is already current or the update succeeded, and non-zero when the update was
 * requested but could not happen — including installs owned by Nix, mise, or a source checkout.
 */
export async function runSelfUpdateCommand(
  input: SelfUpdateInput,
  io: SelfUpdateIo,
): Promise<number> {
  const env = io.env ?? process.env;
  const executablePath = io.executablePath ?? process.execPath;
  const resolveInstalledVersion = io.resolveInstalledVersion ?? resolveCliVersion;
  const installedVersion = resolveInstalledVersion();
  const installSource =
    input.method ??
    (
      io.resolveInstallSource ??
      (() => detectInstallSource({ env, executablePath, version: installedVersion }))
    )();

  if (!SELF_UPDATABLE_SOURCES.includes(installSource)) {
    if (input.version) {
      throw new HunkUserError(
        `Hunk installed with ${describeInstallSource(installSource)} cannot update to a specific version from here.`,
        [unmanagedInstallGuidance(installSource)[1] ?? ""],
      );
    }

    return reportUnmanagedInstall(installSource, installedVersion, input, io);
  }

  if (installSource === "homebrew" && input.version) {
    throw new HunkUserError("Homebrew installs cannot select a specific Hunk version.", [
      "Run `hunk update` without a version to move to the newest formula release.",
    ]);
  }

  const channelVersions = await fetchChannelVersions(installSource, {
    fetchImpl: io.fetchImpl,
    fetchTimeoutMs: io.fetchTimeoutMs,
  });
  const latestVersion = channelVersions.latest;
  const targetVersion = input.version ?? latestVersion;
  const fetchFailedMessage = describeFetchFailure(installSource);

  // `--check` always reports against the channel's real latest release; a requested version is
  // named separately so it is never mislabeled as "latest".
  if (input.check) {
    if (!latestVersion) {
      throw new HunkUserError(fetchFailedMessage, ["Check your network connection."]);
    }

    io.stdout(
      `hunk ${installedVersion} (installed with ${describeInstallSource(installSource)})\n`,
    );
    io.stdout(`latest ${latestVersion}\n`);
    if (input.version) {
      io.stdout(`requested ${input.version}\n`);
    }
    io.stdout(
      isNewerVersion(installedVersion, latestVersion)
        ? "An update is available. Run `hunk update` to install it.\n"
        : "Hunk is up to date.\n",
    );
    return 0;
  }

  if (!targetVersion) {
    throw new HunkUserError(fetchFailedMessage, [
      "Check your network connection, or pass an explicit version.",
    ]);
  }

  // An explicit version is a request to install exactly that, including a downgrade; without one,
  // any installed version that is already at or past the release means there is nothing to do.
  const alreadyCurrent = input.version
    ? installedVersion === targetVersion
    : !isComparableVersion(installedVersion) || !isNewerVersion(installedVersion, targetVersion);
  if (alreadyCurrent) {
    io.stdout(`hunk ${installedVersion} is already up to date.\n`);
    return 0;
  }

  const command = buildUpdateCommand(
    installSource,
    executablePath,
    targetVersion,
    io.platform ?? process.platform,
  );
  // Only the curl installer reads a version from its environment; every other channel names the
  // target in its argv, so the child otherwise inherits this process's environment untouched.
  const commandOptions: SelfUpdateCommandOptions =
    installSource === "curl" ? { env: { ...env, [CURL_INSTALL_VERSION_ENV]: targetVersion } } : {};

  io.stdout(
    `Updating hunk ${installedVersion} -> ${targetVersion} with \`${command.join(" ")}\`\n`,
  );

  const runCommand = io.runCommand ?? spawnUpdateCommand;
  const result = await runCommand(command, commandOptions);
  if (result.exitCode !== 0) {
    const details = result.stderr.trim();
    if (details.length > 0) {
      io.stderr(`${details}\n`);
    }
    io.stderr(`hunk: \`${command.join(" ")}\` failed with exit code ${result.exitCode}.\n`);
    return result.exitCode;
  }

  io.stdout(`Updated hunk to ${targetVersion}.\n`);
  return 0;
}
