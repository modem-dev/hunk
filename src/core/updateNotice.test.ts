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
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • npm i -g hunkdiff",
      });
    });
  });

  test("falls back to beta for npm stable installs when latest is not newer", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "beta:0.8.0-beta.1",
        message: "Update available: 0.8.0-beta.1 (beta) • npm i -g hunkdiff@beta",
      });
    });
  });

  test("npm beta installs choose the higher newer version between latest and beta", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createDistTagsResponse({ latest: "0.8.0", beta: "0.8.1-beta.1" }),
          resolveInstalledVersion: () => "0.8.0-beta.1",
          statePath,
        }),
      ).resolves.toEqual({
        key: "beta:0.8.1-beta.1",
        message: "Update available: 0.8.1-beta.1 (beta) • npm i -g hunkdiff@beta",
      });
    });
  });

  test("uses the Homebrew upgrade command for Homebrew installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          resolveInstallSource: () => "homebrew",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • brew update && brew upgrade hunk",
      });
    });
  });

  test("ignores beta updates for Homebrew installs", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
          resolveInstalledVersion: () => "0.7.0",
          resolveInstallSource: () => "homebrew",
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
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toEqual({
        key: "latest:0.7.1",
        message: "Update available: 0.7.1 (latest) • brew update && brew upgrade hunk",
      });
    });
  });

  test("returns null when already up to date", async () => {
    await withTempStatePath(async (statePath) => {
      await expect(
        resolveStartupUpdateNotice({
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
          fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0" }),
          resolveInstalledVersion: () => "0.7.0",
          statePath,
        }),
      ).resolves.toBeNull();

      await expect(
        resolveStartupUpdateNotice({
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
