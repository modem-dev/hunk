import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionCliCommand,
  ExtensionCliCommandContext,
  ExtensionCliCommandHandler,
  ExtensionEventHandler,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import {
  createGitHubPrExtension,
  fetchGitHubPullRequestDiff,
  type GitHubFetch,
  parseGitHubPrInvocation,
  parseGitHubPullRequestLocator,
  parseGitHubRemoteRepository,
  readGitOrigin,
  resolveGitHubPullRequest,
} from "./index";

const temporaryDirectories: string[] = [];

/** Create one test-owned temporary directory. */
function createTestDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-github-pr-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub PR invocation parsing", () => {
  test("accepts numbers, repository shorthands, URLs, and both repo option forms", () => {
    expect(parseGitHubPrInvocation(["123"])).toMatchObject({
      locator: { number: "123" },
      help: false,
    });
    expect(parseGitHubPrInvocation(["--repo", "modem-dev/hunk", "123"])).toMatchObject({
      locator: { number: "123" },
      explicitRepository: "modem-dev/hunk",
    });
    expect(parseGitHubPrInvocation(["123", "--repo=modem-dev/hunk"])).toMatchObject({
      locator: { number: "123" },
      explicitRepository: "modem-dev/hunk",
    });
    expect(parseGitHubPullRequestLocator("modem-dev/hunk#123")).toEqual({
      owner: "modem-dev",
      repo: "hunk",
      number: "123",
    });
    expect(parseGitHubPullRequestLocator("https://github.com/modem-dev/hunk/pull/123")).toEqual({
      owner: "modem-dev",
      repo: "hunk",
      number: "123",
    });
  });

  test("keeps tokens after the separator for delegated patch options", () => {
    expect(
      parseGitHubPrInvocation(["123", "--repo", "modem-dev/hunk", "--", "--pager"]),
    ).toMatchObject({
      patchArgs: ["--pager"],
    });
    expect(parseGitHubPrInvocation(["--help"])).toMatchObject({ help: true });
  });

  test("rejects malformed or ambiguous invocations", () => {
    for (const args of [
      [],
      ["0"],
      ["-1"],
      ["1.5"],
      ["1", "2"],
      ["1", "--unknown"],
      ["1", "--repo"],
      ["1", "--repo", "a/b", "--repo", "c/d"],
      ["a/b#1", "--repo", "a/b"],
    ]) {
      expect(() => parseGitHubPrInvocation(args)).toThrow();
    }
  });

  test("rejects unsafe repository and URL forms", () => {
    for (const locator of [
      "owner/repo/extra#1",
      "owner%2Frepo/name#1",
      "https://gitlab.com/owner/repo/pull/1",
      "http://github.com/owner/repo/pull/1",
      "https://user@github.com/owner/repo/pull/1",
      "https://github.com/owner/repo/pull/1/files",
      "https://github.com/owner/repo/pull/1?diff=1",
      "https://github.com/owner/repo/pull/1#discussion",
    ]) {
      expect(() => parseGitHubPullRequestLocator(locator)).toThrow();
    }
  });
});

describe("GitHub repository resolution", () => {
  test("parses common github.com remote forms", () => {
    for (const remote of [
      "https://github.com/modem-dev/hunk.git",
      "ssh://git@github.com/modem-dev/hunk.git",
      "git://github.com/modem-dev/hunk.git",
      "git@github.com:modem-dev/hunk.git",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toEqual({ owner: "modem-dev", repo: "hunk" });
    }
  });

  test("rejects non-GitHub and malformed remotes", () => {
    for (const remote of [
      "https://gitlab.com/modem-dev/hunk.git",
      "https://github.com/modem-dev/hunk/extra.git",
      "git@github.com:modem-dev.git",
      "not a remote",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toBeNull();
    }
  });

  test("rejects an already-cancelled origin lookup before spawning Git", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readGitOrigin(process.cwd(), controller.signal)).rejects.toThrow("cancelled");
  });

  test("uses the injected origin only for a bare number", async () => {
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const resolveOrigin = async (cwd: string, receivedSignal: AbortSignal) => {
      expect(receivedSignal).toBe(signal);
      calls.push(cwd);
      return "git@github.com:modem-dev/hunk.git";
    };

    await expect(
      resolveGitHubPullRequest(parseGitHubPrInvocation(["123"]), "/repo", signal, resolveOrigin),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "123" });
    await expect(
      resolveGitHubPullRequest(
        parseGitHubPrInvocation(["modem-dev/hunk#124"]),
        "/elsewhere",
        signal,
        resolveOrigin,
      ),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk", number: "124" });
    expect(calls).toEqual(["/repo"]);
  });
});

describe("GitHub diff fetching", () => {
  test("sends the exact diff request with GH_TOKEN precedence", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response("diff --git a/a.ts b/a.ts\n", { status: 200 });
    }) as GitHubFetch;

    const bytes = await fetchGitHubPullRequestDiff(
      { owner: "modem-dev", repo: "hunk", number: "123" },
      new AbortController().signal,
      { GH_TOKEN: "preferred", GITHUB_TOKEN: "fallback" },
      fetchImpl,
    );

    expect(requestUrl).toBe("https://api.github.com/repos/modem-dev/hunk/pulls/123");
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/vnd.github.v3.diff");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer preferred");
    expect(new TextDecoder().decode(bytes)).toContain("diff --git");
  });

  test("keeps expected header, HTTP, and network errors credential-safe", async () => {
    const target = { owner: "private", repo: "repo", number: "7" };
    let malformedTokenFetches = 0;
    try {
      await fetchGitHubPullRequestDiff(
        target,
        new AbortController().signal,
        { GH_TOKEN: "top-secret\nvalue" },
        (async () => {
          malformedTokenFetches += 1;
          return new Response("unexpected");
        }) as GitHubFetch,
      );
      throw new Error("Expected malformed token rejection.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("cannot be sent in an HTTP header");
      expect(message).not.toContain("top-secret");
      expect(message).not.toContain("value");
    }
    expect(malformedTokenFetches).toBe(0);

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
      const fetchImpl = (async () => response) as GitHubFetch;
      try {
        await fetchGitHubPullRequestDiff(
          target,
          new AbortController().signal,
          { GH_TOKEN: "top-secret-token" },
          fetchImpl,
        );
        throw new Error("Expected the request to fail.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("top-secret-token");
        expect(message).not.toContain("secret response body");
      }
    }

    await expect(
      fetchGitHubPullRequestDiff(target, new AbortController().signal, {}, (async () => {
        throw new Error("network internals");
      }) as GitHubFetch),
    ).rejects.toThrow("could not be reached");
  });
});

describe("GitHub PR extension lifecycle", () => {
  test("fetches, delegates to patch, and removes the temporary patch on shutdown", async () => {
    let command: ExtensionCliCommand | undefined;
    let handler: ExtensionCliCommandHandler | undefined;
    let shutdown: ExtensionEventHandler<"shutdown"> | undefined;
    const temporaryRoot = createTestDirectory();
    const patch = "diff --git a/src/pr.ts b/src/pr.ts\n--- a/src/pr.ts\n+++ b/src/pr.ts\n";
    const extension = createGitHubPrExtension({
      temporaryRoot,
      env: {},
      fetchImpl: (async () => new Response(patch, { status: 200 })) as GitHubFetch,
      resolveOrigin: async () => "git@github.com:modem-dev/hunk.git",
    });
    extension({
      registerCliCommand(
        registered: ExtensionCliCommand,
        registeredHandler: ExtensionCliCommandHandler,
      ) {
        command = registered;
        handler = registeredHandler;
      },
      on(event: string, registeredHandler: ExtensionEventHandler) {
        if (event === "shutdown") {
          shutdown = registeredHandler as ExtensionEventHandler<"shutdown">;
        }
      },
    } as unknown as HunkExtensionAPI);

    expect(command).toEqual({
      name: "gh",
      summary: "Review a GitHub pull request",
      usage: "<number|owner/repo#number|pull-request-url> [--repo <owner/repo>]",
    });
    if (!handler || !shutdown) throw new Error("Expected command and shutdown registrations.");

    let stdoutWrites = 0;
    let stdinReads = 0;
    const stderr: string[] = [];
    const context = {
      cwd: "/repo",
      signal: new AbortController().signal,
      stdin: {
        async *[Symbol.asyncIterator]() {
          stdinReads += 1;
          yield new Uint8Array();
        },
      },
      stdout: {
        async write() {
          stdoutWrites += 1;
        },
      },
      stderr: {
        async write(chunk: string | Uint8Array) {
          stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        },
      },
    } satisfies ExtensionCliCommandContext;

    const result = await handler(["123", "--", "--pager"], context);
    expect(result).toMatchObject({ kind: "delegate" });
    if (result.kind !== "delegate") throw new Error("Expected patch delegation.");
    expect(result.argv[0]).toBe("patch");
    expect(result.argv.slice(2)).toEqual(["--pager"]);
    const patchPath = result.argv[1]!;
    expect(readFileSync(patchPath, "utf8")).toBe(patch);
    expect(stdoutWrites).toBe(0);
    expect(stdinReads).toBe(0);
    expect(stderr.join("")).toContain("Fetching GitHub pull request modem-dev/hunk#123");

    await shutdown({}, {} as never);
    expect(existsSync(patchPath)).toBe(false);
    await shutdown({}, {} as never);
  });

  test("cancels after temporary input creation without returning a delegate", async () => {
    let handler: ExtensionCliCommandHandler | undefined;
    const temporaryRoot = createTestDirectory();
    const controller = new AbortController();
    createGitHubPrExtension({
      temporaryRoot,
      env: {},
      fetchImpl: (async () => new Response("diff --git a/a b/a\n", { status: 200 })) as GitHubFetch,
    })({
      registerCliCommand(
        _command: ExtensionCliCommand,
        registeredHandler: ExtensionCliCommandHandler,
      ) {
        handler = registeredHandler;
      },
      on() {},
    } as unknown as HunkExtensionAPI);
    if (!handler) throw new Error("Expected command registration.");

    let stderrWrites = 0;
    await expect(
      handler(["1", "--repo", "owner/repo"], {
        cwd: "/repo",
        signal: controller.signal,
        stdin: { async *[Symbol.asyncIterator]() {} },
        stdout: { async write() {} },
        stderr: {
          async write() {
            stderrWrites += 1;
            if (stderrWrites === 2) controller.abort();
          },
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  test("retains delegated patches while a replacement registry adopts the same factory", async () => {
    const temporaryRoot = createTestDirectory();
    const extension = createGitHubPrExtension({
      temporaryRoot,
      env: {},
      fetchImpl: (async () => new Response("diff --git a/a b/a\n", { status: 200 })) as GitHubFetch,
    });
    const registrations: Array<{
      handler?: ExtensionCliCommandHandler;
      shutdown?: ExtensionEventHandler<"shutdown">;
    }> = [];
    const register = () => {
      const captured: (typeof registrations)[number] = {};
      extension({
        registerCliCommand(
          _command: ExtensionCliCommand,
          registeredHandler: ExtensionCliCommandHandler,
        ) {
          captured.handler = registeredHandler;
        },
        on(event: string, registeredHandler: ExtensionEventHandler) {
          if (event === "shutdown") {
            captured.shutdown = registeredHandler as ExtensionEventHandler<"shutdown">;
          }
        },
      } as unknown as HunkExtensionAPI);
      registrations.push(captured);
      return captured;
    };

    const first = register();
    if (!first.handler || !first.shutdown) throw new Error("Expected first registration.");
    const result = await first.handler(["1", "--repo", "owner/repo"], {
      cwd: "/repo",
      signal: new AbortController().signal,
      stdin: { async *[Symbol.asyncIterator]() {} },
      stdout: { async write() {} },
      stderr: { async write() {} },
    });
    if (result.kind !== "delegate") throw new Error("Expected patch delegation.");
    const patchPath = result.argv[1]!;

    const replacement = register();
    if (!replacement.shutdown) throw new Error("Expected replacement registration.");
    await first.shutdown({}, {} as never);
    expect(existsSync(patchPath)).toBe(true);
    await replacement.shutdown({}, {} as never);
    expect(existsSync(patchPath)).toBe(false);
  });

  test("owns extension help without reading Git or the network", async () => {
    let handler: ExtensionCliCommandHandler | undefined;
    let originReads = 0;
    let fetches = 0;
    createGitHubPrExtension({
      resolveOrigin: async () => {
        originReads += 1;
        return "";
      },
      fetchImpl: (async () => {
        fetches += 1;
        throw new Error("unexpected");
      }) as GitHubFetch,
    })({
      registerCliCommand(
        _command: ExtensionCliCommand,
        registeredHandler: ExtensionCliCommandHandler,
      ) {
        handler = registeredHandler;
      },
      on() {},
    } as unknown as HunkExtensionAPI);
    if (!handler) throw new Error("Expected command registration.");

    const output: string[] = [];
    const result = await handler(["--help"], {
      cwd: "/repo",
      signal: new AbortController().signal,
      stdin: { async *[Symbol.asyncIterator]() {} },
      stdout: {
        async write(chunk) {
          output.push(String(chunk));
        },
      },
      stderr: { async write() {} },
    });
    expect(result).toEqual({ kind: "exit" });
    expect(output.join("")).toContain("Usage: hunk gh");
    expect(originReads).toBe(0);
    expect(fetches).toBe(0);
  });

  test("declares a dependency-free API-v10 folder extension", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as {
      dependencies?: unknown;
      devDependencies?: unknown;
      hunk?: { apiVersion?: number; extensions?: string[] };
    };
    expect(manifest.hunk).toEqual({ extensions: ["./index.ts"], apiVersion: 10 });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });
});
