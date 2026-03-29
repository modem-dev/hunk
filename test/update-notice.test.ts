import { describe, expect, test } from "bun:test";
import { resolveStartupUpdateNotice } from "../src/core/updateNotice";

/** Build one JSON response that mimics the npm dist-tags payload. */
function createDistTagsResponse(tags: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(tags), {
    status,
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
        fetchImpl: async () => createDistTagsResponse({ latest: "0.8.0", beta: "0.8.1-beta.1" }),
        resolveInstalledVersion: () => "0.8.0-beta.1",
      }),
    ).resolves.toEqual({
      key: "beta:0.8.1-beta.1",
      message: "Update available: 0.8.1-beta.1 (beta) • npm i -g hunkdiff@beta",
    });
  });

  test("returns null when already up to date", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.7.0-beta.1" }),
        resolveInstalledVersion: () => "0.7.0",
      }),
    ).resolves.toBeNull();
  });

  test("returns null for unresolved local versions", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => createDistTagsResponse({ latest: "0.7.0", beta: "0.8.0-beta.1" }),
        resolveInstalledVersion: () => "0.0.0-unknown",
      }),
    ).resolves.toBeNull();
  });

  test("returns null on non-ok responses", async () => {
    await expect(
      resolveStartupUpdateNotice({
        fetchImpl: async () => createDistTagsResponse({ latest: "0.7.1" }, 503),
        resolveInstalledVersion: () => "0.7.0",
      }),
    ).resolves.toBeNull();
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

  test("aborts hung fetches after the timeout", async () => {
    let aborted = false;

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
      }),
    ).resolves.toBeNull();

    expect(aborted).toBe(true);
  });
});
