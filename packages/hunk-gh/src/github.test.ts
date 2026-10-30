import { describe, expect, test } from "bun:test";
import {
  fetchGitHubCommitDiff,
  fetchGitHubCompareDiff,
  fetchGitHubPullRequestDiff,
  fetchGitHubPullRequestMetadata,
  findOpenPullRequestForBranch,
  findOpenPullRequestForCommit,
  parseGitHubPullRequestMetadata,
} from "./github";
import type { GitHubFetch } from "./types";

const signal = () => new AbortController().signal;

describe("GitHub pull-request discovery", () => {
  const repository = { owner: "contributor", repo: "hunk" };
  const sha = "a".repeat(40);

  test("queries the exact fork commit and returns the open PR's base repository", async () => {
    let requested = "";
    let requestInit: RequestInit | undefined;
    await expect(
      findOpenPullRequestForCommit(repository, "feature/topic", sha, signal(), {}, (async (
        url,
        init,
      ) => {
        requested = String(url);
        requestInit = init;
        return new Response(
          JSON.stringify([
            {
              number: 123,
              state: "open",
              base: { repo: { full_name: "modem-dev/hunk" } },
            },
          ]),
        );
      }) as GitHubFetch),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "123" });
    const url = new URL(requested);
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://api.github.com/repos/contributor/hunk/commits/${sha}/pulls`,
    );
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/vnd.github+json");
  });

  test("falls back to the pushed branch tip when local HEAD is not on GitHub", async () => {
    const upstreamSha = "b".repeat(40);
    const requests: string[] = [];
    await expect(
      findOpenPullRequestForBranch(
        repository,
        { branch: "feature/topic", sha, upstreamSha },
        signal(),
        {},
        (async (url) => {
          requests.push(String(url));
          if (requests.length === 1) return new Response("", { status: 404 });
          return Response.json([
            {
              number: 123,
              state: "open",
              base: { repo: { full_name: "modem-dev/hunk" } },
            },
          ]);
        }) as GitHubFetch,
      ),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "123" });
    expect(requests[0]).toContain(`/commits/${sha}/pulls`);
    expect(requests[1]).toContain(`/commits/${upstreamSha}/pulls`);
  });

  test("filters closed PRs and preserves exact-one open semantics", async () => {
    const entry = (number: number, state: "open" | "closed") => ({
      number,
      state,
      base: { repo: { full_name: "modem-dev/hunk" } },
    });
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "one",
        sha,
        signal(),
        {},
        (async () =>
          new Response(
            JSON.stringify([
              { number: 9, state: "closed", base: { repo: null } },
              entry(1, "open"),
            ]),
          )) as GitHubFetch,
      ),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "1" });
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "none",
        sha,
        signal(),
        {},
        (async () => new Response(JSON.stringify([entry(1, "closed")]))) as GitHubFetch,
      ),
    ).rejects.toThrow("No accessible open pull request");
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "many",
        sha,
        signal(),
        {},
        (async () =>
          new Response(JSON.stringify([entry(1, "open"), entry(2, "open")]))) as GitHubFetch,
      ),
    ).rejects.toThrow("Multiple accessible open pull requests");
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "paged",
        sha,
        signal(),
        {},
        (async () =>
          new Response(JSON.stringify([entry(1, "open")]), {
            headers: { link: '<https://api.github.com/next>; rel="next"' },
          })) as GitHubFetch,
      ),
    ).rejects.toThrow("paginated PR matches");
  });

  test("rejects malformed and oversized metadata", async () => {
    await expect(
      findOpenPullRequestForCommit(repository, "topic", "not-a-sha", signal()),
    ).rejects.toThrow("valid commit SHA");
    for (const body of [
      "not json",
      "{}",
      '[{"number":1,"state":"open"}]',
      '[{"number":"1","state":"open","base":{"repo":{"full_name":"modem-dev/hunk"}}}]',
      '[{"number":1,"state":"unknown","base":{"repo":{"full_name":"modem-dev/hunk"}}}]',
      '[{"number":1,"state":"open","base":{"repo":{"full_name":"invalid"}}}]',
    ]) {
      await expect(
        findOpenPullRequestForCommit(
          repository,
          "topic",
          sha,
          signal(),
          {},
          (async () => new Response(body)) as GitHubFetch,
        ),
      ).rejects.toThrow("malformed PR metadata");
    }
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "topic",
        sha,
        signal(),
        {},
        (async () =>
          new Response("[]", {
            headers: { "content-length": String(1024 * 1024 + 1) },
          })) as GitHubFetch,
      ),
    ).rejects.toThrow("1 MiB");

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      findOpenPullRequestForCommit(
        repository,
        "topic",
        sha,
        signal(),
        {},
        (async () => new Response(body)) as GitHubFetch,
      ),
    ).rejects.toThrow("1 MiB");
    expect(cancelled).toBe(true);
  });

  test("uses credential-safe API, auth, rate-limit, redirect, and cancellation errors", async () => {
    for (const [response, message] of [
      [new Response("secret", { status: 401 }), "rejected the configured token"],
      [
        new Response("secret", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
        "rate limiting",
      ],
      [new Response("secret", { status: 403 }), "denied PR discovery"],
      [new Response("secret", { status: 404 }), "accessible commit"],
      [new Response(null, { status: 302 }), "refusing to forward credentials"],
      [new Response("secret", { status: 500 }), "HTTP 500"],
    ] as const) {
      try {
        await findOpenPullRequestForCommit(
          repository,
          "topic",
          sha,
          signal(),
          { GH_TOKEN: "top-secret" },
          (async () => response) as GitHubFetch,
        );
        throw new Error("Expected discovery failure.");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        expect(text).toContain(message);
        expect(text).not.toContain("top-secret");
        expect(text).not.toContain("secret");
      }
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      findOpenPullRequestForCommit(repository, "topic", sha, controller.signal, {}, (async () => {
        throw new Error("abort internals");
      }) as GitHubFetch),
    ).rejects.toThrow("cancelled");
  });
});

describe("GitHub pull-request metadata", () => {
  const target = { owner: "modem-dev", repo: "hunk", number: "123" };
  const metadata = {
    title: "Describe delegated reviews",
    html_url: "https://github.com/modem-dev/hunk/pull/123",
    user: { login: "octocat" },
    state: "open",
    draft: false,
    merged: false,
    base: { ref: "main" },
    head: { ref: "feature/review-info" },
  };

  test("fetches and validates the exact review descriptor fields", async () => {
    let requestInit: RequestInit | undefined;
    const review = await fetchGitHubPullRequestMetadata(
      target,
      signal(),
      { GH_TOKEN: "preferred" },
      (async (_url, init) => {
        requestInit = init;
        return Response.json(metadata);
      }) as GitHubFetch,
    );
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/vnd.github+json");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer preferred");
    expect(requestInit?.redirect).toBe("manual");
    expect(review).toEqual({
      kind: "change-request",
      provider: "GitHub",
      title: "Describe delegated reviews",
      url: "https://github.com/modem-dev/hunk/pull/123",
      id: "#123",
      repository: "modem-dev/hunk",
      author: "octocat",
      base: "main",
      head: "feature/review-info",
      state: "open",
      draft: false,
    });
  });

  test("rejects terminal controls and PR URLs that do not match the target", () => {
    expect(() =>
      parseGitHubPullRequestMetadata({ ...metadata, title: "forged\u001b[2Jtitle" }, target),
    ).toThrow("malformed pull-request metadata");
    expect(() =>
      parseGitHubPullRequestMetadata(
        { ...metadata, html_url: "https://github.com/attacker/repo/pull/123" },
        target,
      ),
    ).toThrow("malformed pull-request metadata");
  });
});

describe("GitHub pull-request fetching", () => {
  test("sends the exact diff request with GH_TOKEN precedence", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const bytes = await fetchGitHubPullRequestDiff(
      { owner: "modem-dev", repo: "hunk", number: "123" },
      signal(),
      { GH_TOKEN: "preferred", GITHUB_TOKEN: "fallback" },
      (async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response("diff --git a/a.ts b/a.ts\n", { status: 200 });
      }) as GitHubFetch,
    );
    expect(requestUrl).toBe("https://api.github.com/repos/modem-dev/hunk/pulls/123");
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/vnd.github.v3.diff");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer preferred");
    expect(new TextDecoder().decode(bytes)).toContain("diff --git");
  });

  test("keeps malformed tokens, HTTP errors, and network errors credential-safe", async () => {
    const target = { owner: "private", repo: "repo", number: "7" };
    let fetches = 0;
    await expect(
      fetchGitHubPullRequestDiff(target, signal(), { GH_TOKEN: "top-secret\nvalue" }, (async () => {
        fetches += 1;
        return new Response("unexpected");
      }) as GitHubFetch),
    ).rejects.toThrow("cannot be sent in an HTTP header");
    expect(fetches).toBe(0);

    for (const response of [
      new Response("secret response body", { status: 401 }),
      new Response("secret response body", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      new Response("secret response body", { status: 404 }),
      new Response("secret response body", { status: 500 }),
      new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
    ]) {
      try {
        await fetchGitHubPullRequestDiff(
          target,
          signal(),
          { GH_TOKEN: "top-secret-token" },
          (async () => response) as GitHubFetch,
        );
        throw new Error("Expected the request to fail.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("top-secret-token");
        expect(message).not.toContain("secret response body");
      }
    }

    await expect(
      fetchGitHubPullRequestDiff(target, signal(), {}, (async () => {
        throw new Error("network internals");
      }) as GitHubFetch),
    ).rejects.toThrow("could not be reached");
  });

  test("rejects declared and streamed bodies over 64 MiB", async () => {
    const target = { owner: "modem-dev", repo: "hunk", number: "1" };
    await expect(
      fetchGitHubPullRequestDiff(
        target,
        signal(),
        {},
        (async () =>
          new Response("small", {
            headers: { "content-length": String(64 * 1024 * 1024 + 1) },
          })) as GitHubFetch,
      ),
    ).rejects.toThrow("64 MiB");

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 * 1024));
        controller.enqueue(new Uint8Array(32 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchGitHubPullRequestDiff(
        target,
        signal(),
        {},
        (async () => new Response(body)) as GitHubFetch,
      ),
    ).rejects.toThrow("64 MiB");
    expect(cancelled).toBe(true);
  });

  test("stops reading a streamed body when cancelled", async () => {
    const controller = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls += 1;
        stream.enqueue(new TextEncoder().encode("diff --git a/a b/a\n"));
        controller.abort();
      },
    });

    await expect(
      fetchGitHubPullRequestDiff(
        { owner: "modem-dev", repo: "hunk", number: "1" },
        controller.signal,
        {},
        (async () => new Response(body)) as GitHubFetch,
      ),
    ).rejects.toThrow("cancelled");
    expect(pulls).toBe(1);
  });
});

describe("GitHub comparison fetching", () => {
  test("encodes refs independently and requests a bounded diff without redirects", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const bytes = await fetchGitHubCompareDiff(
      { owner: "modem-dev", repo: "hunk" },
      "release/v1",
      "feature#topic",
      signal(),
      { GH_TOKEN: "token" },
      (async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response("diff --git a/a b/a\n");
      }) as GitHubFetch,
    );
    expect(requestUrl).toBe(
      "https://api.github.com/repos/modem-dev/hunk/compare/release%2Fv1...feature%23topic",
    );
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/vnd.github.v3.diff");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer token");
    expect(new TextDecoder().decode(bytes)).toContain("diff --git");
  });

  test("keeps tokens and response bodies out of comparison errors", async () => {
    for (const response of [
      new Response("sensitive body", { status: 401 }),
      new Response("sensitive body", { status: 403 }),
      new Response("sensitive body", { status: 404 }),
      new Response("sensitive body", { status: 500 }),
      new Response(null, { status: 302 }),
    ]) {
      try {
        await fetchGitHubCompareDiff(
          { owner: "private", repo: "repo" },
          "base",
          "head",
          signal(),
          { GH_TOKEN: "top-secret-token" },
          (async () => response) as GitHubFetch,
        );
        throw new Error("Expected comparison failure.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("top-secret-token");
        expect(message).not.toContain("sensitive body");
      }
    }
  });

  test("reports a successful empty comparison as no changes", async () => {
    for (const response of [new Response(""), new Response(null)]) {
      await expect(
        fetchGitHubCompareDiff(
          { owner: "modem-dev", repo: "hunk" },
          "base",
          "head",
          signal(),
          {},
          (async () => response) as GitHubFetch,
        ),
      ).rejects.toThrow("no changes between base and head");
    }
  });

  test("reports cancellation and network failures without transport details", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchGitHubCompareDiff(
        { owner: "modem-dev", repo: "hunk" },
        "base",
        "head",
        controller.signal,
        {},
        (async () => {
          throw new Error("network internals");
        }) as GitHubFetch,
      ),
    ).rejects.toThrow("cancelled");
    const streamingController = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(new TextEncoder().encode("diff --git a/a b/a\n"));
        streamingController.abort();
      },
    });
    await expect(
      fetchGitHubCompareDiff(
        { owner: "modem-dev", repo: "hunk" },
        "base",
        "head",
        streamingController.signal,
        {},
        (async () => new Response(body)) as GitHubFetch,
      ),
    ).rejects.toThrow("diff loading was cancelled");

    await expect(
      fetchGitHubCompareDiff(
        { owner: "modem-dev", repo: "hunk" },
        "base",
        "head",
        signal(),
        {},
        (async () => {
          throw new Error("network internals");
        }) as GitHubFetch,
      ),
    ).rejects.toThrow("could not be reached");
  });
});

describe("GitHub commit fetching", () => {
  test("requests the commit diff without following redirects", async () => {
    let requestUrl = "";
    const bytes = await fetchGitHubCommitDiff(
      { owner: "modem-dev", repo: "hunk" },
      "abcdef1",
      signal(),
      {},
      (async (url, init) => {
        requestUrl = String(url);
        expect(init?.redirect).toBe("manual");
        return new Response("diff --git a/a b/a\n", { status: 200 });
      }) as GitHubFetch,
    );
    expect(requestUrl).toBe("https://api.github.com/repos/modem-dev/hunk/commits/abcdef1");
    expect(new TextDecoder().decode(bytes)).toContain("diff --git");
  });

  test("applies the same malformed-token and redirect safeguards", async () => {
    let fetches = 0;
    await expect(
      fetchGitHubCommitDiff(
        { owner: "private", repo: "repo" },
        "abcdef1",
        signal(),
        { GH_TOKEN: "secret\nvalue" },
        (async () => {
          fetches += 1;
          return new Response("unexpected");
        }) as GitHubFetch,
      ),
    ).rejects.toThrow("cannot be sent in an HTTP header");
    expect(fetches).toBe(0);

    await expect(
      fetchGitHubCommitDiff(
        { owner: "private", repo: "repo" },
        "abcdef1",
        signal(),
        { GH_TOKEN: "secret" },
        (async () => new Response("sensitive body", { status: 302 })) as GitHubFetch,
      ),
    ).rejects.toThrow("refusing to forward credentials");
  });
});
