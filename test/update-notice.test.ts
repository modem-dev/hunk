import { describe, expect, test } from "bun:test";
import { resolveStartupUpdateNotice } from "../src/core/updateNotice";

/** Build one JSON response that mimics the npm dist-tags payload. */
function createDistTagsResponse(tags: Record<string, unknown>) {
  return new Response(JSON.stringify(tags), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("startup update notice", () => {
  test("prefers latest for stable installs when latest is newer", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1", beta: "0.8.0-beta.1" }),
        resolveInstalledVersion: () => "0.7.0",
      }),
    ).resolves.toEqual({
      key: "latest:0.7.1",
      message: "Update available: 0.7.1 (latest) • npm i -g hunkdiff",
    });
  });

  test("falls back to beta for stable installs when latest is not newer", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
        resolveInstalledVersion: () => "0.7.0",
      }),
    ).resolves.toEqual({
      key: "beta:0.8.0-beta.1",
      message: "Update available: 0.8.0-beta.1 (beta) • npm i -g hunkdiff@beta",
    });
  });

  test("beta installs choose the higher newer version between latest and beta", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () =>
          createDistTagsResponse({ latest: "0.8.0", beta: "0.8.1-beta.1" }),
        resolveInstalledVersion: () => "0.8.0-beta.1",
      }),
    ).resolves.toEqual({
      key: "beta:0.8.1-beta.1",
      message: "Update available: 0.8.1-beta.1 (beta) • npm i -g hunkdiff@beta",
    });
  });

  test("returns null on fetch failure", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => {
          throw new Error("network down");
        },
        resolveInstalledVersion: () => "0.7.0",
      }),
    ).resolves.toBeNull();
  });
});
