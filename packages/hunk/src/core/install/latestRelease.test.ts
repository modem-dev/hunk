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

  test("reads curl release metadata through the first-party endpoint", async () => {
    const requested: string[] = [];
    const headers: Headers[] = [];

    await expect(
      fetchChannelVersions("curl", {
        env: {},
        requestSource: "startup",
        currentVersion: "1.3.0",
        fetchImpl: async (input, init) => {
          requested.push(String(input));
          headers.push(new Headers(init?.headers));
          return jsonResponse({ version: "1.4.0" });
        },
      }),
    ).resolves.toEqual({ latest: "1.4.0" });
    expect(requested).toEqual(["https://updates.hunk.dev/v1/curl/latest"]);
    expect(headers[0]?.get("x-hunk-request-source")).toBe("startup");
    expect(headers[0]?.get("x-hunk-current-version")).toBe("1.3.0");
  });

  test("falls back to GitHub when the first-party endpoint fails or is invalid", async () => {
    for (const proxyResponse of [jsonResponse({}, 503), jsonResponse({ version: "invalid" })]) {
      const requested: string[] = [];
      const accepts: Array<string | null> = [];
      await expect(
        fetchChannelVersions("curl", {
          env: {},
          fetchImpl: async (input, init) => {
            requested.push(String(input));
            accepts.push(new Headers(init?.headers).get("accept"));
            return requested.length === 1
              ? proxyResponse.clone()
              : jsonResponse({ tag_name: "v1.4.0" });
          },
        }),
      ).resolves.toEqual({ latest: "1.4.0" });
      expect(requested).toEqual([
        "https://updates.hunk.dev/v1/curl/latest",
        "https://api.github.com/repos/modem-dev/hunk/releases/latest",
      ]);
      expect(accepts).toEqual([null, "application/vnd.github+json"]);
    }
  });

  test("bypasses first-party analytics when either opt-out is set", async () => {
    for (const env of [{ HUNK_DISABLE_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }]) {
      const requested: string[] = [];
      await expect(
        fetchChannelVersions("curl", {
          env,
          fetchImpl: async (input) => {
            requested.push(String(input));
            return jsonResponse({ tag_name: "v1.4.0" });
          },
        }),
      ).resolves.toEqual({ latest: "1.4.0" });
      expect(requested).toEqual(["https://api.github.com/repos/modem-dev/hunk/releases/latest"]);
    }
  });

  test("drops curl release metadata that is not a stable version", async () => {
    await expect(
      fetchChannelVersions("curl", {
        env: {},
        fetchImpl: async (input) =>
          String(input).includes("updates.hunk.dev")
            ? jsonResponse({ version: "1.4.0-beta.1" })
            : jsonResponse({ tag_name: "v1.4.0-beta.1" }),
      }),
    ).resolves.toEqual({ latest: undefined });

    await expect(
      fetchChannelVersions("curl", {
        env: {},
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
