import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { InstallSource } from "./installSource";
import {
  parseUpdateMethod,
  parseUpdateVersion,
  runSelfUpdateCommand,
  type SelfUpdateInput,
  type SelfUpdateProcessResult,
  UPDATE_METHOD_VALUES,
} from "./selfUpdate";

/** Build one JSON response for an injected fetch. */
function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface UpdateRunOptions {
  input?: Partial<SelfUpdateInput>;
  installSource: InstallSource;
  installedVersion?: string;
  executablePath?: string;
  platform?: NodeJS.Platform;
  latestVersion?: string;
  env?: NodeJS.ProcessEnv;
  commandResult?: SelfUpdateProcessResult;
}

/** Run one `hunk update` invocation offline, capturing output and the spawned command. */
async function runUpdate(options: UpdateRunOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  const commandEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const latestVersion = options.latestVersion ?? "1.1.0";

  const exitCode = await runSelfUpdateCommand(
    { check: false, ...options.input },
    {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      env: options.env ?? {},
      executablePath: options.executablePath ?? join("/", "usr", "bin", "hunk"),
      platform: options.platform ?? "linux",
      resolveInstalledVersion: () => options.installedVersion ?? "1.0.0",
      resolveInstallSource: () => options.installSource,
      // One payload carrying every registry shape, so a `--method` override still resolves.
      fetchImpl: async () =>
        jsonResponse({
          latest: latestVersion,
          versions: { stable: latestVersion },
          tag_name: `v${latestVersion}`,
        }),
      runCommand: async (command, commandOptions) => {
        commands.push([...command]);
        commandEnvs.push(commandOptions?.env);
        return options.commandResult ?? { exitCode: 0, stderr: "" };
      },
    },
  );

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    commands,
    commandEnvs,
  };
}

/**
 * The exact script `hunk update` spawns for curl installs: download to a file, then execute, so
 * a failed fetch aborts instead of feeding `sh` empty input; wget stands in for curl.
 */
const CURL_UPDATE_PIPELINE = [
  "set -e",
  'tmp="$(mktemp)"',
  "trap 'rm -f \"$tmp\"' EXIT",
  'if command -v curl >/dev/null 2>&1; then curl -fsSL https://hunk.dev/install.sh -o "$tmp"; else wget -qO "$tmp" https://hunk.dev/install.sh; fi',
  'sh "$tmp"',
].join("; ");

describe("update method parsing", () => {
  test("normalizes brew to the Homebrew install source", () => {
    expect(parseUpdateMethod("brew")).toBe("homebrew");
    expect(parseUpdateMethod("Homebrew")).toBe("homebrew");
    expect(parseUpdateMethod("npm")).toBe("npm");
  });

  test("maps curl to the install-script source", () => {
    expect(parseUpdateMethod("curl")).toBe("curl");
    expect(parseUpdateMethod("CURL")).toBe("curl");
  });

  test("names the supported methods for unknown values", () => {
    expect(() => parseUpdateMethod("apt")).toThrow("Unknown update method: apt");
    expect(UPDATE_METHOD_VALUES).toEqual(["npm", "brew", "curl"]);

    try {
      parseUpdateMethod("apt");
      throw new Error("parseUpdateMethod should have rejected an unknown method");
    } catch (error) {
      expect((error as { suggestions?: string[] }).suggestions).toEqual([
        "Supported methods are `npm`, `brew`, and `curl`.",
      ]);
    }
  });
});

describe("update version parsing", () => {
  test("accepts exact release versions, with or without a tag prefix", () => {
    expect(parseUpdateVersion("0.19.0")).toBe("0.19.0");
    expect(parseUpdateVersion("v1.2.3")).toBe("1.2.3");
    expect(parseUpdateVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  test("rejects npm specs that are not a plain version", () => {
    for (const value of ["latest", "^1.2.0", "npm:evil@1.0.0", "../local-dir", "1.2.3 --flag"]) {
      expect(() => parseUpdateVersion(value)).toThrow(`Invalid version: ${value}`);
    }
  });
});

describe("hunk update", () => {
  test("detects untagged source builds when no install source is injected", async () => {
    const stdout: string[] = [];
    const exitCode = await runSelfUpdateCommand(
      { check: false },
      {
        stdout: (text) => stdout.push(text),
        stderr: () => {},
        env: {},
        executablePath: join("/", "opt", "somewhere", "hunk"),
        resolveInstalledVersion: () => "0.0.0-unknown",
        fetchImpl: async () => jsonResponse({}),
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("Hunk is running from a local source build.");
  });

  test("installs the newest npm release with the npm client", async () => {
    const result = await runUpdate({ installSource: "npm", latestVersion: "1.1.0" });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([["npm", "install", "--global", "hunkdiff@1.1.0"]]);
    expect(result.stdout).toContain("Updating hunk 1.0.0 -> 1.1.0");
    expect(result.stdout).toContain("Updated hunk to 1.1.0.");
  });

  test("names the npm .cmd shim explicitly on Windows", async () => {
    const result = await runUpdate({ installSource: "npm", platform: "win32" });

    expect(result.commands).toEqual([["npm.cmd", "install", "--global", "hunkdiff@1.1.0"]]);
  });

  test("uses bun for a bun global install", async () => {
    const result = await runUpdate({
      installSource: "npm",
      executablePath: join("/", "home", "reviewer", ".bun", "bin", "hunk"),
    });

    expect(result.commands).toEqual([["bun", "add", "--global", "hunkdiff@1.1.0"]]);
  });

  test("uses pnpm for a pnpm global install", async () => {
    const result = await runUpdate({
      installSource: "npm",
      executablePath: join("/", "home", "reviewer", ".local", "share", "pnpm", "hunk"),
    });

    expect(result.commands).toEqual([["pnpm", "add", "--global", "hunkdiff@1.1.0"]]);
  });

  test("installs an explicitly requested version, including a downgrade", async () => {
    const result = await runUpdate({
      installSource: "npm",
      installedVersion: "1.1.0",
      input: { version: "0.9.0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([["npm", "install", "--global", "hunkdiff@0.9.0"]]);
  });

  test("upgrades Homebrew installs from the formula version", async () => {
    const result = await runUpdate({ installSource: "homebrew", latestVersion: "1.1.0" });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([["brew", "upgrade", "hunk"]]);
  });

  test("re-runs the install script for curl installs", async () => {
    const result = await runUpdate({
      installSource: "curl",
      latestVersion: "1.1.0",
      env: { PATH: "/usr/bin", HOME: "/home/reviewer" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([["sh", "-c", CURL_UPDATE_PIPELINE]]);
    // The installer resolves the version from its environment, so the child carries the target
    // alongside the rest of this process's environment.
    expect(result.commandEnvs).toEqual([
      { PATH: "/usr/bin", HOME: "/home/reviewer", HUNK_VERSION: "1.1.0" },
    ]);
    expect(result.stdout).toContain("Updated hunk to 1.1.0.");
  });

  test("pins an explicitly requested version for curl installs", async () => {
    const result = await runUpdate({
      installSource: "curl",
      installedVersion: "1.1.0",
      input: { version: "0.9.0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([["sh", "-c", CURL_UPDATE_PIPELINE]]);
    expect(result.commandEnvs[0]?.HUNK_VERSION).toBe("0.9.0");
  });

  test("reports the GitHub release version for a curl --check", async () => {
    const result = await runUpdate({ installSource: "curl", input: { check: true } });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("hunk 1.0.0 (installed with the install script)");
    expect(result.stdout).toContain("latest 1.1.0");
  });

  test("refuses to pin a version on Homebrew", async () => {
    await expect(
      runUpdate({ installSource: "homebrew", input: { version: "1.0.5" } }),
    ).rejects.toThrow("Homebrew installs cannot select a specific Hunk version.");
  });

  test("does nothing when the installed version is already current", async () => {
    const result = await runUpdate({
      installSource: "npm",
      installedVersion: "1.1.0",
      latestVersion: "1.1.0",
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("hunk 1.1.0 is already up to date.");
  });

  test("does nothing when the installed version is newer than the release", async () => {
    const result = await runUpdate({
      installSource: "npm",
      installedVersion: "1.2.0",
      latestVersion: "1.1.0",
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([]);
  });

  test("reports versions without installing for --check", async () => {
    const result = await runUpdate({ installSource: "npm", input: { check: true } });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("hunk 1.0.0 (installed with npm)");
    expect(result.stdout).toContain("latest 1.1.0");
    expect(result.stdout).toContain("An update is available.");
  });

  test("reports the channel's real latest release when --check is given a version", async () => {
    const result = await runUpdate({
      installSource: "npm",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0",
      input: { check: true, version: "0.0.1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("latest 1.1.0");
    expect(result.stdout).toContain("requested 0.0.1");
    expect(result.stdout).toContain("An update is available.");
  });

  test("surfaces the package manager's stderr and exit code on failure", async () => {
    const result = await runUpdate({
      installSource: "npm",
      commandResult: { exitCode: 7, stderr: "npm ERR! EACCES permission denied\n" },
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("npm ERR! EACCES permission denied");
    expect(result.stderr).toContain("failed with exit code 7");
  });

  test("fails clearly when the release lookup returns nothing", async () => {
    await expect(
      runSelfUpdateCommand(
        { check: false },
        {
          stdout: () => {},
          stderr: () => {},
          env: {},
          resolveInstalledVersion: () => "1.0.0",
          resolveInstallSource: () => "npm",
          fetchImpl: async () => {
            throw new Error("network down");
          },
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
        },
      ),
    ).rejects.toThrow("Could not read the latest Hunk version from the npm registry.");
  });

  test("honors an explicit --method over the detected install source", async () => {
    const result = await runUpdate({
      installSource: "dev",
      input: { method: "homebrew" },
    });

    expect(result.commands).toEqual([["brew", "upgrade", "hunk"]]);
  });

  test("points Nix installs at their own configuration and spawns nothing", async () => {
    const result = await runUpdate({ installSource: "nix" });

    expect(result.exitCode).toBe(1);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("Hunk was installed with Nix.");
  });

  test("points mise installs at mise up", async () => {
    const result = await runUpdate({ installSource: "mise" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Run `mise up hunk` to update it.");
  });

  test("points pacman installs at pacman or an AUR helper", async () => {
    const result = await runUpdate({ installSource: "pacman" });

    expect(result.exitCode).toBe(1);
    expect(result.commands).toEqual([]);
    expect(result.stdout).toContain("Update it through pacman or your AUR helper.");
  });

  test("points source builds at install:bin", async () => {
    const result = await runUpdate({ installSource: "dev", installedVersion: "0.0.0-unknown" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("hunk 0.0.0-unknown (installed with a local source build)");
    expect(result.stdout).toContain(
      "Run `bun run install:bin` in your Hunk checkout to update it.",
    );
  });

  test("refuses an explicit version for installs Hunk does not manage", async () => {
    await expect(runUpdate({ installSource: "mise", input: { version: "1.2.3" } })).rejects.toThrow(
      "Hunk installed with mise cannot update to a specific version from here.",
    );
  });

  test("reports unmanaged installs successfully for --check", async () => {
    const result = await runUpdate({ installSource: "mise", input: { check: true } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hunk was installed with mise.");
  });
});
