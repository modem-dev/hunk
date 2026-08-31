import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLATFORM_PACKAGE_MATRIX } from "./prebuilt-package-helpers";

/**
 * Covers `install.sh` at the repository root, the script published at https://hunk.dev/install.sh
 * (staged into the website build by `scripts/stage-install-script.ts`).
 *
 * The script is the one piece of Hunk that runs before Hunk exists, so it is checked as text and
 * as a shell program: it must parse under a POSIX shell, name the same release archives the
 * publish workflow uploads, and resolve every published macOS/Linux platform pair. The platform
 * checks source the script's own detection functions with `uname` stubbed, which needs a POSIX
 * shell, so they stay Unix-only.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const INSTALL_SCRIPT_PATH = join(REPO_ROOT, "install.sh");
const INSTALL_SCRIPT = readFileSync(INSTALL_SCRIPT_PATH, "utf8");

/** Platform pairs the installer serves: every published package except the Windows one. */
const CURL_INSTALLABLE_SPECS = PLATFORM_PACKAGE_MATRIX.filter((spec) => spec.os !== "windows");

/** Write a minimal Hunk executable that reports one version. */
function writeFakeHunk(path: string, version: string) {
  writeFileSync(path, `#!/bin/sh\nprintf '${version}\\n'\n`);
  chmodSync(path, 0o755);
}

/** Run the installer against an already-current managed target without downloading anything. */
function runConflictCheck(
  options: {
    force?: boolean;
    forceEnv?: boolean;
    targetFirst?: boolean;
    aliasOnly?: boolean;
    targetDirectoryAlias?: boolean;
    duplicateForeignAlias?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "hunk-install-conflict-"));
  const home = join(root, "home");
  const targetDir = join(home, ".hunk", "bin");
  const foreignDir = join(root, "foreign", "bin");
  const inactiveNvmDir = join(home, ".nvm", "versions", "node", "v20.0.0", "bin");
  const targetAliasDir = join(root, "target-bin-alias");
  const foreignAliasDir = join(root, "foreign-bin-alias");
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(foreignDir, { recursive: true });
  mkdirSync(inactiveNvmDir, { recursive: true });
  writeFakeHunk(join(targetDir, "hunk"), "1.2.3");
  if (options.aliasOnly) {
    symlinkSync(join(targetDir, "hunk"), join(foreignDir, "hunk"));
  } else {
    writeFakeHunk(join(foreignDir, "hunk"), "0.9.0");
  }
  if (!options.aliasOnly) writeFakeHunk(join(inactiveNvmDir, "hunk"), "0.8.0");
  if (options.targetDirectoryAlias) symlinkSync(targetDir, targetAliasDir, "dir");
  if (options.duplicateForeignAlias) symlinkSync(foreignDir, foreignAliasDir, "dir");

  try {
    const systemPath = "/usr/local/bin:/usr/bin:/bin";
    let pathEntries = options.targetFirst
      ? [targetDir, foreignDir, systemPath]
      : [foreignDir, targetDir, systemPath];
    if (options.targetDirectoryAlias) pathEntries = [targetAliasDir, foreignDir, systemPath];
    if (options.duplicateForeignAlias) {
      pathEntries = [foreignDir, foreignAliasDir, targetDir, systemPath];
    }
    const result = Bun.spawnSync(
      ["sh", INSTALL_SCRIPT_PATH, ...(options.force ? ["--force"] : [])],
      {
        env: {
          ...process.env,
          HOME: home,
          HUNK_VERSION: "1.2.3",
          HUNK_ALLOW_CONFLICTING_INSTALLS: options.forceEnv ? "1" : undefined,
          PATH: pathEntries.join(":"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout).toString("utf8"),
      stderr: Buffer.from(result.stderr).toString("utf8"),
      target: join(targetDir, "hunk"),
      foreign: join(foreignDir, "hunk"),
      inactiveNvm: join(inactiveNvmDir, "hunk"),
      inactiveNvmNpm: join(inactiveNvmDir, "npm"),
      targetAlias: join(targetAliasDir, "hunk"),
      foreignAlias: join(foreignAliasDir, "hunk"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run the installer's platform detection with a stubbed `uname` and print `<os> <arch>`.
 *
 * The script keeps every statement inside `main`, called on its last line, so everything before
 * `main() {` is pure function definitions: sourcing that prefix runs nothing, and the harness can
 * call the detection functions directly. The stubs shadow `uname` (and `sysctl`) as shell
 * functions, which take precedence over the real executables.
 */
function detectPlatform(unameSystem: string, unameMachine: string, translated = "0") {
  const scriptDir = mkdtempSync(join(tmpdir(), "hunk-install-sh-"));
  const harnessPath = join(scriptDir, "detect.sh");
  const [definitionsBody] = INSTALL_SCRIPT.split("main() {");

  try {
    writeFileSync(
      harnessPath,
      [
        "#!/bin/sh",
        "set -eu",
        `uname() { if [ "\${1:-}" = "-m" ]; then printf '%s\\n' '${unameMachine}'; else printf '%s\\n' '${unameSystem}'; fi; }`,
        `sysctl() { printf '%s\\n' '${translated}'; }`,
        // The installer's function definitions, without the main invocation.
        definitionsBody ?? "",
        'os="$(detect_os)"',
        'arch="$(detect_arch)"',
        'printf "%s %s\\n" "$os" "$arch"',
        "",
      ].join("\n"),
    );

    const result = Bun.spawnSync(["sh", harnessPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout).toString("utf8").trim(),
      stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe("hunk.dev install script", () => {
  test("parses as a POSIX shell program", () => {
    const result = Bun.spawnSync(["sh", "-n", INSTALL_SCRIPT_PATH], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(Buffer.from(result.stderr).toString("utf8")).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("names the release assets the publish workflow uploads", () => {
    expect(INSTALL_SCRIPT).toContain('archive_name="${package_name}.tar.gz"');
    expect(INSTALL_SCRIPT).toContain('package_name="hunkdiff-${os}-${arch}"');
    expect(INSTALL_SCRIPT).toContain("SHA256SUMS");
    expect(INSTALL_SCRIPT).toContain("https://github.com/${REPO}/releases/download");
  });

  test("installs beside the bundled skills so skill resolution still finds them", () => {
    // `resolveBundledSkillPath` walks up from the binary looking for `skills/<name>/SKILL.md`,
    // so the payload directory must be the binary's directory or one of its ancestors.
    expect(INSTALL_SCRIPT).toContain('bin_dir="${payload_dir}/bin"');
    expect(INSTALL_SCRIPT).toContain('mv "${temp_dir}/extract/skills" "${payload_dir}/skills.new"');
    expect(INSTALL_SCRIPT).toContain('mv "${payload_dir}/skills.new" "${payload_dir}/skills"');
    expect(INSTALL_SCRIPT).toContain("--strip-components=1");
  });

  test("defers every statement to a main call on the last line", () => {
    // A `curl | sh` pipe executes statements as they stream in, so a truncated download must die
    // on an unclosed function body instead of running a prefix of the install.
    const lines = INSTALL_SCRIPT.trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
    expect(INSTALL_SCRIPT).toContain("main() {");
  });

  test("points unsupported platforms at the npm package", () => {
    expect(INSTALL_SCRIPT).toContain("npm install -g hunkdiff");
  });

  test.skipIf(process.platform === "win32")(
    "refuses every visible and inactive-nvm competing install with exact remediation",
    () => {
      const result = runConflictCheck();

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `${result.foreign} (another package manager; version 0.9.0; shadows ${result.target})`,
      );
      expect(result.stderr).toContain(
        `${result.inactiveNvm} (npm; version 0.8.0; not on the current PATH)`,
      );
      expect(result.stderr).toContain(`'${result.inactiveNvmNpm}' uninstall -g hunkdiff`);
      expect(result.stderr).toContain("rerun this installer with --force");
      expect(result.stdout).not.toContain("Downloading");
    },
  );

  test.skipIf(process.platform === "win32")(
    "names when the managed target shadows a competing install",
    () => {
      const result = runConflictCheck({ targetFirst: true });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `${result.foreign} (another package manager; version 0.9.0; is shadowed by ${result.target})`,
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "uses canonical PATH identities for shadowing through a managed-directory alias",
    () => {
      const result = runConflictCheck({ targetDirectoryAlias: true });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `${result.foreign} (another package manager; version 0.9.0; is shadowed by ${result.target})`,
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports one conflict when PATH contains directory aliases to the same foreign install",
    () => {
      const result = runConflictCheck({ duplicateForeignAlias: true });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.match(/version 0\.9\.0/g)).toHaveLength(1);
      expect(result.stderr).not.toContain(result.foreignAlias);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not treat a PATH symlink to the managed binary as another install",
    () => {
      const result = runConflictCheck({ aliasOnly: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hunk 1.2.3 is already installed.");
    },
  );

  test.skipIf(process.platform === "win32")(
    "allows the scripted force environment variable",
    () => {
      const result = runConflictCheck({ forceEnv: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hunk 1.2.3 is already installed.");
      expect(result.stderr).toBe("");
    },
  );

  test.skipIf(process.platform === "win32")(
    "allows an explicit force flag and preserves the already-current fast path",
    () => {
      const result = runConflictCheck({ force: true });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hunk 1.2.3 is already installed.");
      expect(result.stdout).not.toContain("Downloading");
      expect(result.stderr).toBe("");
    },
  );

  test.skipIf(process.platform === "win32")(
    "resolves every published macOS and Linux platform pair",
    () => {
      const detected = [
        { spec: "linux x64", ...detectPlatform("Linux", "x86_64") },
        { spec: "linux arm64", ...detectPlatform("Linux", "aarch64") },
        { spec: "darwin x64", ...detectPlatform("Darwin", "x86_64") },
        { spec: "darwin arm64", ...detectPlatform("Darwin", "arm64") },
      ];

      expect(detected.map((entry) => `${entry.spec}: ${entry.stdout}`)).toEqual([
        "linux x64: linux x64",
        "linux arm64: linux arm64",
        "darwin x64: darwin x64",
        "darwin arm64: darwin arm64",
      ]);
      // Every pair the installer resolves must be a package the release workflow publishes.
      for (const entry of detected) {
        const [os, arch] = entry.stdout.split(" ");
        expect(CURL_INSTALLABLE_SPECS.some((spec) => spec.os === os && spec.cpu === arch)).toBe(
          true,
        );
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "corrects a Rosetta-translated shell to the native arm64 build",
    () => {
      expect(detectPlatform("Darwin", "x86_64", "1").stdout).toBe("darwin arm64");
    },
  );

  test.skipIf(process.platform === "win32")("rejects Windows-style uname output", () => {
    const result = detectPlatform("MINGW64_NT-10.0-22631", "x86_64");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("npm install -g hunkdiff");
  });

  test.skipIf(process.platform === "win32")("rejects unsupported architectures", () => {
    const result = detectPlatform("Linux", "riscv64");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported architecture: riscv64");
  });
});
