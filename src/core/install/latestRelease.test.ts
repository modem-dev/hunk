import { describe, expect, test } from "bun:test";
import { fetchChannelVersions } from "./latestRelease";

/** Build one JSON response for an injected fetch. */
function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("release channel lookups", () => {
  test("reads npm dist-tags for npm installs", async () => {
    const requested: string[] = [];

    await expect(
      fetchChannelVersions("npm", {
        fetchImpl: async (input) => {
          requested.push(String(input));
          return jsonResponse({ latest: "1.2.3", beta: "1.3.0-beta.1" });
        },
      }),
    ).resolves.toEqual({ latest: "1.2.3", beta: "1.3.0-beta.1" });
    expect(requested).toEqual(["https://registry.npmjs.org/-/package/hunkdiff/dist-tags"]);
  });

  test("reads the Homebrew formula's stable version for Homebrew installs", async () => {
    const requested: string[] = [];

    await expect(
      fetchChannelVersions("homebrew", {
        fetchImpl: async (input) => {
          requested.push(String(input));
          return jsonResponse({ versions: { stable: "1.2.0", head: "HEAD" } });
        },
      }),
    ).resolves.toEqual({ latest: "1.2.0" });
    expect(requested).toEqual(["https://formulae.brew.sh/api/formula/hunk.json"]);
  });

  test("reads the newest GitHub release tag for curl installer installs", async () => {
    const requested: string[] = [];
    const accepts: unknown[] = [];

    await expect(
      fetchChannelVersions("curl", {
        fetchImpl: async (input, init) => {
          requested.push(String(input));
          accepts.push(new Headers(init?.headers).get("accept"));
          return jsonResponse({ tag_name: "v1.4.0" });
        },
      }),
    ).resolves.toEqual({ latest: "1.4.0" });
    expect(requested).toEqual(["https://api.github.com/repos/modem-dev/hunk/releases/latest"]);
    expect(accepts).toEqual(["application/vnd.github+json"]);
  });

  test("drops a GitHub release tag that is not a stable version", async () => {
    await expect(
      fetchChannelVersions("curl", {
        fetchImpl: async () => jsonResponse({ tag_name: "v1.4.0-beta.1" }),
      }),
    ).resolves.toEqual({ latest: undefined });

    await expect(
      fetchChannelVersions("curl", {
        fetchImpl: async () => jsonResponse({ name: "1.4.0" }),
      }),
    ).resolves.toEqual({ latest: undefined });
  });

  test("asks no registry for install sources Hunk cannot update", async () => {
    for (const source of ["nix", "mise", "dev"] as const) {
      await expect(
        fetchChannelVersions(source, {
          fetchImpl: async () => {
            throw new Error(`should not fetch for ${source} installs`);
          },
        }),
      ).resolves.toEqual({});
    }
  });

  test("drops versions that are not normalized semver", async () => {
    await expect(
      fetchChannelVersions("npm", {
        fetchImpl: async () => jsonResponse({ latest: "v1.2.3", beta: "1.3.0" }),
      }),
    ).resolves.toEqual({ latest: undefined, beta: undefined });
  });

  test("returns nothing for failed and non-ok responses", async () => {
    await expect(
      fetchChannelVersions("homebrew", {
        fetchImpl: async () => jsonResponse({ versions: { stable: "1.2.0" } }, 503),
      }),
    ).resolves.toEqual({ latest: undefined });

    await expect(
      fetchChannelVersions("npm", {
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).resolves.toEqual({ latest: undefined, beta: undefined });
  });

  test("aborts hung lookups after the timeout", async () => {
    let aborted = false;

    await expect(
      fetchChannelVersions("npm", {
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
      }),
    ).resolves.toEqual({ latest: undefined, beta: undefined });
    expect(aborted).toBe(true);
  });
});
