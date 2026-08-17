import { HunkUserError } from "../run/errors";
import { detectInstallSource, detectNpmClient, type InstallSource } from "./installSource";
import { fetchChannelVersions, type FetchImpl } from "./latestRelease";
import { isComparableVersion, isNewerVersion, resolveCliVersion } from "../run/version";

/**
 * Runs `hunk update`: replaces this Hunk install with a published release, or explains who can.
 *
 * The install source decides everything. npm and Homebrew installs are replaced in place by
 * spawning the package manager that owns them; Nix, mise, and local source builds are owned by
 * something Hunk must not run behind the user's back, so those print the one command that does
 * work and stop. Every input the command reads or writes — environment, executable path, network,
 * child processes, output streams — arrives through `SelfUpdateIo` so tests drive it offline.
 */

const NPM_PACKAGE_NAME = "hunkdiff";
const HOMEBREW_FORMULA_NAME = "hunk";

/** Install methods `--method` accepts, keyed by the spelling users type. */
const UPDATE_METHOD_ALIASES: Record<string, InstallSource> = {
  npm: "npm",
  brew: "homebrew",
  homebrew: "homebrew",
};

/** Accepted `--method` values, in the order the help and error messages list them. */
export const UPDATE_METHOD_VALUES = ["npm", "brew"] as const;

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
  runCommand?: (command: readonly string[]) => Promise<SelfUpdateProcessResult>;
}

/** Normalize one `--method` value, or explain which values exist. */
export function parseUpdateMethod(value: string): InstallSource {
  const method = UPDATE_METHOD_ALIASES[value.toLowerCase()];
  if (!method) {
    throw new HunkUserError(`Unknown update method: ${value}`, [
      `Supported methods are ${UPDATE_METHOD_VALUES.map((name) => `\`${name}\``).join(" and ")}.`,
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

/** Spawn one package-manager command, streaming its output and capturing stderr for failures. */
async function spawnUpdateCommand(command: readonly string[]): Promise<SelfUpdateProcessResult> {
  const [executable] = command;
  try {
    const child = Bun.spawn({
      cmd: [...command],
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

  if (installSource !== "npm" && installSource !== "homebrew") {
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
  const fetchFailedMessage =
    installSource === "homebrew"
      ? "Could not read the latest Hunk version from the Homebrew formula API."
      : "Could not read the latest Hunk version from the npm registry.";

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

  const command =
    installSource === "homebrew"
      ? ["brew", "upgrade", HOMEBREW_FORMULA_NAME]
      : npmUpdateCommand(executablePath, targetVersion, io.platform ?? process.platform);

  io.stdout(
    `Updating hunk ${installedVersion} -> ${targetVersion} with \`${command.join(" ")}\`\n`,
  );

  const runCommand = io.runCommand ?? spawnUpdateCommand;
  const result = await runCommand(command);
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
