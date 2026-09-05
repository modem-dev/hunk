import { describe, expect, test } from "bun:test";
import type { InstallSource } from "../../packages/hunk/src/core/install/installSource";

/**
 * Runs `hunk update` as a black box with a forced install source.
 *
 * Only the sources Hunk refuses to update itself are exercised here, so the command never reaches
 * the network or a package manager: `HUNK_INSTALL_SOURCE` pins the source, and every one of these
 * paths reports and stops before any release lookup.
 */
function runUpdate(args: string[], installSource?: InstallSource) {
  const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "update", ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: installSource
      ? { ...process.env, HUNK_INSTALL_SOURCE: installSource }
      : { ...process.env },
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

describe("hunk update CLI contract", () => {
  test("top-level help lists the update command", () => {
    const proc = Bun.spawnSync(["bun", "run", "packages/hunk/src/main.tsx", "--help"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("hunk update [version]");
    expect(stdout).toContain("update Hunk with the package manager that installed it");
  });

  test("prints update help without terminal takeover sequences", () => {
    const result = runUpdate(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: update [options] [version]");
    expect(result.stdout).toContain("--method <method>");
    expect(result.stdout).toContain("npm, brew, curl");
    expect(result.stdout).toContain("--check");
    expect(result.stdout).toContain("hunk update --method brew");
    expect(result.stdout).toContain("hunk update --method curl");
    expect(result.stdout).not.toContain("[?1049h");
  });

  test("points Nix installs at their own configuration", () => {
    const result = runUpdate([], "nix");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("(installed with Nix)");
    expect(result.stdout).toContain("Update it through your Nix configuration");
    expect(result.stdout).not.toContain("[?1049h");
  });

  test("points mise installs at mise up", () => {
    const result = runUpdate([], "mise");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Run `mise up hunk` to update it.");
  });

  test("points local source builds at install:bin", () => {
    const result = runUpdate([], "dev");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("(installed with a local source build)");
    expect(result.stdout).toContain(
      "Run `bun run install:bin` in your Hunk checkout to update it.",
    );
  });

  test("reports an unmanaged install successfully for --check", () => {
    const result = runUpdate(["--check"], "dev");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(installed with a local source build)");
  });

  test("names the supported methods for an unknown --method", () => {
    const result = runUpdate(["--method", "apt"], "dev");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown update method: apt");
    expect(result.stderr).toContain("Supported methods are `npm`, `brew`, and `curl`.");
  });

  test("accepts curl as an explicit update method", () => {
    // `--method curl` with an unresolvable version reaches argument validation and stops there,
    // so the contract is checked without a release lookup or an install.
    const result = runUpdate(["--method", "curl", "not-a-version"], "dev");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid version: not-a-version");
    expect(result.stderr).not.toContain("Unknown update method");
  });

  test("rejects unknown update flags", () => {
    const result = runUpdate(["--not-a-real-flag"], "dev");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--not-a-real-flag");
  });
});
