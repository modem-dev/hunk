import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLATFORM_PACKAGE_MATRIX } from "./prebuilt-package-helpers";

/**
 * Covers `website/public/install.sh`, the script published at https://hunk.dev/install.sh.
 *
 * The script is the one piece of Hunk that runs before Hunk exists, so it is checked as text and
 * as a shell program: it must parse under a POSIX shell, name the same release archives the
 * publish workflow uploads, and resolve every published macOS/Linux platform pair. The platform
 * checks source the script's own detection functions with `uname` stubbed, which needs a POSIX
 * shell, so they stay Unix-only.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const INSTALL_SCRIPT_PATH = join(REPO_ROOT, "website", "public", "install.sh");
const INSTALL_SCRIPT = readFileSync(INSTALL_SCRIPT_PATH, "utf8");

/** Platform pairs the installer serves: every published package except the Windows one. */
const CURL_INSTALLABLE_SPECS = PLATFORM_PACKAGE_MATRIX.filter((spec) => spec.os !== "windows");

/**
 * Run the installer's platform detection with a stubbed `uname` and print `<os> <arch>`.
 *
 * The script is sourced with its own body truncated at the detection call, so nothing downloads:
 * the stub shadows `uname` (and `sysctl`) as shell functions, which take precedence over the real
 * executables.
 */
function detectPlatform(unameSystem: string, unameMachine: string, translated = "0") {
  const scriptDir = mkdtempSync(join(tmpdir(), "hunk-install-sh-"));
  const harnessPath = join(scriptDir, "detect.sh");
  const [detectionBody] = INSTALL_SCRIPT.split('package_name="hunkdiff-');

  try {
    writeFileSync(
      harnessPath,
      [
        "#!/bin/sh",
        "set -eu",
        `uname() { if [ "\${1:-}" = "-m" ]; then printf '%s\\n' '${unameMachine}'; else printf '%s\\n' '${unameSystem}'; fi; }`,
        `sysctl() { printf '%s\\n' '${translated}'; }`,
        // The installer's own text, stopping just before it starts naming release archives.
        detectionBody ?? "",
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
    expect(INSTALL_SCRIPT).toContain('mv "${temp_dir}/extract/skills" "${payload_dir}/skills"');
    expect(INSTALL_SCRIPT).toContain("--strip-components=1");
  });

  test("points unsupported platforms at the npm package", () => {
    expect(INSTALL_SCRIPT).toContain("npm install -g hunkdiff");
  });

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
