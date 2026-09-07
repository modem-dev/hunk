import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStartupUpdateNotice } from "./updateNotice";

/** Build one JSON response that mimics the npm dist-tags payload. */
function createDistTagsResponse(tags: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(tags), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build one JSON response that mimics the Homebrew formula API payload. */
function createFormulaResponse(stable: string) {
  return new Response(JSON.stringify({ versions: { stable } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Build one JSON response that mimics the GitHub latest-release payload. */
function createGitHubReleaseResponse(tagName: string) {
  return new Response(JSON.stringify({ tag_name: tagName }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Executable path of a plain global npm install, pinned so detection never reads the host. */
const NPM_EXECUTABLE_PATH = join("/", "usr", "lib", "node_modules", "hunkdiff", "bin", "hunk");

async function withTempStatePath(run: (statePath: string) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), "hunk-startup-notice-"));
  const statePath = join(stateDir, "state.json");

  try {
    await run(statePath);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("startup update notice", () => {
  test("prefers latest for stable installs when latest is newer", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
    });
  });

  test("falls back to beta for npm stable installs when latest is not newer", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "beta:0.8.0-beta.1",
        message: "Update available: 0.8.0-beta.1 (beta) • run `hunk update 0.8.0-beta.1`",
      });
    });
  });

  test("npm beta installs choose the higher newer version between latest and beta", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.8.0", beta: "0.8.1-beta.1" }),
          resolveInstalledVersion: () => "0.8.0-beta.1",
          statePath,
        }),
      ).resolves.toEqual({
        key: "beta:0.8.1-beta.1",
        message: "Update available: 0.8.1-beta.1 (beta) • run `hunk update 0.8.1-beta.1`",
      });
    });
  });

  test("reads the Homebrew formula, not npm, for Homebrew installs", async () => {
    await withTempStatePath(async (statePath) => {
      const requested: string[] = [];

      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async (input) => {
            requested.push(String(input));
            return createFormulaResponse("0.7.1");
          },
          resolveInstalledVersion: () => "0.7.0",
          resolveInstallSource: () => "homebrew",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
      expect(requested).toEqual(["https://formulae.brew.sh/api/formula/hunk.json"]);
    });
  });

  test("stays quiet for Homebrew installs while the formula still lags npm", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createFormulaResponse("0.7.0"),
          resolveInstalledVersion: () => "0.7.0",
          resolveInstallSource: () => "homebrew",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("reads the GitHub releases API for curl installer installs", async () => {
    await withTempStatePath(async (statePath) => {
      const requested: string[] = [];

      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async (input) => {
            requested.push(String(input));
            return createGitHubReleaseResponse("v0.7.1");
          },
          resolveExecutablePath: () => join("/", "home", "reviewer", ".hunk", "bin", "hunk"),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
      expect(requested).toEqual(["https://api.github.com/repos/modem-dev/hunk/releases/latest"]);
    });
  });

  test("stays quiet for curl installs already on the newest release", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createGitHubReleaseResponse("v0.7.0"),
          resolveInstallSource: () => "curl",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("detects Homebrew installs from the HUNK_INSTALL_SOURCE environment variable", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "homebrew" },
          fetchImpl: async () => createFormulaResponse("0.7.1"),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
    });
  });

  test("detects unmarked Homebrew installs from their Cellar executable", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: {},
          fetchImpl: async () => createFormulaResponse("0.7.1"),
          resolveExecutablePath: () => "/opt/homebrew/Cellar/hunk/0.7.0/bin/hunk",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
    });
  });

  test("suppresses update notices for local source builds", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "dev" },
          fetchImpl: async () => {
            throw new Error("should not fetch for source builds");
          },
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("uses a neutral Nix update instruction for Nix installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "nix" },
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • update Hunk through your Nix configuration",
      });
    });
  });

  test("detects unmarked nixpkgs installs from their Nix store executable", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: {},
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1" }),
          resolveExecutablePath: () => "/nix/store/hash-hunk/bin/hunk",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • update Hunk through your Nix configuration",
      });
    });
  });

  test("ignores beta updates for Nix installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "nix" },
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("suppresses update notices for mise-managed installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "mise" },
          fetchImpl: async () => {
            throw new Error("should not fetch for mise installs");
          },
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("suppresses update notices for pacman-managed installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: { HUNK_INSTALL_SOURCE: "pacman" },
          fetchImpl: async () => {
            throw new Error("should not fetch for pacman installs");
          },
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("detects unmarked mise installs from their mise install path", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: {},
          fetchImpl: async () => {
            throw new Error("should not fetch for mise installs");
          },
          resolveExecutablePath: () =>
            "/home/user/.local/share/mise/installs/aqua-modem-dev-hunk/0.7.0/hunk",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("detects unmarked mise installs from Windows-style install paths", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: {},
          fetchImpl: async () => {
            throw new Error("should not fetch for mise installs");
          },
          resolveExecutablePath: () =>
            "C:\\Users\\user\\AppData\\Local\\mise\\installs\\aqua-modem-dev-hunk\\0.7.0\\hunk.exe",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("never surfaces beta or latest notices for a resolved mise install source", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          resolveInstallSource: () => "mise",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("keeps npm notices for paths that only mention mise outside an install directory", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          env: {},
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1" }),
          resolveExecutablePath: () => "/home/mise/projects/hunk/node_modules/.bin/hunk",
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • run `hunk update`",
      });
    });
  });

  test("returns null when already up to date", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.7.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("stores the current version on first run without showing a copied-skill notice", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hunk-startup-notice-"));
    const statePath = join(stateDir, "state.json");

    try {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();

      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        version: 1,
        lastSeenCliVersion: "0.7.0",
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("shows a one-time copied-skill refresh notice after a version change", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hunk-startup-notice-"));
    const statePath = join(stateDir, "state.json");
    let fetchCalled = false;

    try {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();

      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => {
            fetchCalled = true;
            return createDistTagsResponse({ latest: "0.8.0" });
          },
          resolveInstalledVersion: () => "0.8.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "skill:0.8.0",
        message: "Hunk 0.8.0 installed • If your agent copied Hunk's skill, run hunk skill path",
      });

      expect(fetchCalled).toBe(false);

      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.8.0" }),
          resolveInstalledVersion: () => "0.8.0",
          statePath,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("returns null for unresolved local versions", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.0.0-unknown",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("returns null on non-ok responses", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1" }, 503),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("returns null on fetch failure", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async () => {
            throw new Error("network down");
          },
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });
  });

  test("returns null immediately when the CI disable env is set", async () => {
    const previous = process.env.HUNK_DISABLE_UPDATE_NOTICE;
    process.env.HUNK_DISABLE_UPDATE_NOTICE = "1";

    try {
      await withTempStatePath(async (statePath) => {
        await expect(
          resolveStartupUpdateNotice({
            resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
            fetchImpl: async () => {
              throw new Error("should not fetch when disabled");
            },
            resolveInstalledVersion: () => "0.7.0",
            statePath,
          }),
        ).resolves.toBeNull();
      });
    } finally {
      if (previous === undefined) {
        delete process.env.HUNK_DISABLE_UPDATE_NOTICE;
      } else {
        process.env.HUNK_DISABLE_UPDATE_NOTICE = previous;
      }
    }
  });

  test("aborts hung fetches after the timeout", async () => {
    let aborted = false;

    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          resolveExecutablePath: () => NPM_EXECUTABLE_PATH,
          fetchImpl: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
          fetchTimeoutMs: 10,
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();
    });

    expect(aborted).toBe(true);
  });
});
