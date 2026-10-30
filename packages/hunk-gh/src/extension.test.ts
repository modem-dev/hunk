import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionCliCommand,
  ExtensionCliCommandContext,
  ExtensionCliCommandHandler,
  ExtensionEventHandler,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import { createGitHubPrExtension, parseGitHubRepository } from "./index";
import type { GitHubFetch } from "./types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Creates one test-owned temporary directory. */
function createTestDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-gh-extension-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Builds the exact GitHub metadata fields shown in delegated review chrome. */
function createTestPullRequestMetadata(number = "123", owner = "modem-dev", repo = "hunk") {
  return {
    title: "Describe delegated reviews",
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    user: { login: "octocat" },
    state: "open",
    draft: false,
    merged: false,
    base: { ref: "main" },
    head: { ref: "feature/review-info" },
  };
}

/** Mocks the JSON and diff representations served by one GitHub PR endpoint. */
function createTestPullRequestFetch(patch: string): GitHubFetch {
  return (async (url, init) => {
    if (new Headers(init?.headers).get("accept") === "application/vnd.github+json") {
      const parts = new URL(String(url)).pathname.split("/");
      return Response.json(createTestPullRequestMetadata(parts[5], parts[2], parts[3]));
    }
    return new Response(patch);
  }) as GitHubFetch;
}

/** Captures the CLI command and shutdown handler registered by one factory. */
function registerTestExtension(extension = createGitHubPrExtension()) {
  const captured: {
    command?: ExtensionCliCommand;
    handler?: ExtensionCliCommandHandler;
    shutdown?: ExtensionEventHandler<"shutdown">;
  } = {};
  extension({
    registerCliCommand(command: ExtensionCliCommand, handler: ExtensionCliCommandHandler) {
      captured.command = command;
      captured.handler = handler;
    },
    on(event: string, handler: ExtensionEventHandler) {
      if (event === "shutdown") captured.shutdown = handler as ExtensionEventHandler<"shutdown">;
    },
  } as unknown as HunkExtensionAPI);
  return captured;
}

/** Creates a command context that records output without consuming stdin. */
function createTestContext(signal = new AbortController().signal) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdinReads = 0;
  const context = {
    cwd: "/repo",
    signal,
    stdin: {
      async *[Symbol.asyncIterator]() {
        stdinReads += 1;
        yield new Uint8Array();
      },
    },
    stdout: {
      async write(chunk: string | Uint8Array) {
        stdout.push(String(chunk));
      },
    },
    stderr: {
      async write(chunk: string | Uint8Array) {
        stderr.push(String(chunk));
      },
    },
  } satisfies ExtensionCliCommandContext;
  return { context, stdout, stderr, stdinReads: () => stdinReads };
}

describe("GitHub command dispatch", () => {
  test("loads through the tiny root entry point and preserves named exports", () => {
    expect(createGitHubPrExtension).toBeTypeOf("function");
    expect(parseGitHubRepository("modem-dev/hunk")).toEqual({
      owner: "modem-dev",
      repo: "hunk",
    });
  });

  test("registers the gh namespace and serves all help without I/O", async () => {
    let originReads = 0;
    let fetches = 0;
    const registration = registerTestExtension(
      createGitHubPrExtension({
        resolveOrigin: async () => {
          originReads += 1;
          return "";
        },
        fetchImpl: (async () => {
          fetches += 1;
          throw new Error("unexpected");
        }) as GitHubFetch,
      }),
    );
    expect(registration.command).toEqual({
      name: "gh",
      summary: "Review GitHub pull requests, commits, and comparisons",
      usage: "<pr|commit|compare> <target> [--repo <owner/repo>]",
    });
    if (!registration.handler) throw new Error("Expected command registration.");

    for (const [args, usage] of [
      [["--help"], "Usage: hunk gh <command>"],
      [["pr", "--help"], "Usage: hunk gh pr"],
      [["commit", "--help"], "Usage: hunk gh commit"],
      [["compare", "--help"], "Usage: hunk gh compare"],
    ] as const) {
      const output = createTestContext();
      await expect(registration.handler(args, output.context)).resolves.toEqual({ kind: "exit" });
      expect(output.stdout.join("")).toContain(usage);
    }
    expect(originReads).toBe(0);
    expect(fetches).toBe(0);
  });

  test("rejects unknown GitHub subcommands without echoing terminal controls", async () => {
    const registration = registerTestExtension();
    if (!registration.handler) throw new Error("Expected command registration.");
    await expect(registration.handler(["issue", "1"], createTestContext().context)).rejects.toThrow(
      "Unknown GitHub command",
    );
    await expect(
      registration.handler(["forged\u001b[2Jcommand"], createTestContext().context),
    ).rejects.toThrow("cannot contain control characters");
  });

  test.each([
    {
      args: ["pr", "123", "--", "--pager"],
      expectedUrl: "/pulls/123",
      expectedMessage: "pull request modem-dev/hunk#123",
      expectedFilename: "hunk-pr-123.diff",
    },
    {
      args: ["commit", "ABCDEF1", "--", "--pager"],
      expectedUrl: "/commits/abcdef1",
      expectedMessage: "commit modem-dev/hunk@abcdef1",
      expectedFilename: "hunk-commit-abcdef1.diff",
    },
    {
      args: ["commit", "other/project@ABCDEF1", "--", "--pager"],
      expectedUrl: "/repos/other/project/commits/abcdef1",
      expectedMessage: "commit other/project@abcdef1",
      expectedFilename: "project-commit-abcdef1.diff",
    },
    {
      args: ["commit", "https://github.com/other/project/commit/ABCDEF1", "--", "--pager"],
      expectedUrl: "/repos/other/project/commits/abcdef1",
      expectedMessage: "commit other/project@abcdef1",
      expectedFilename: "project-commit-abcdef1.diff",
    },
    {
      args: ["compare", "release/v1...feature/topic", "--", "--pager"],
      expectedUrl: "/compare/release%2Fv1...feature%2Ftopic",
      expectedMessage: "comparison modem-dev/hunk:release/v1...feature/topic",
      expectedFilename: "hunk-compare.diff",
    },
  ])("fetches and delegates the $args[0] command", async (scenario) => {
    const temporaryRoot = createTestDirectory();
    const patch = "diff --git a/src/a.ts b/src/a.ts\n";
    let requestUrl = "";
    const registration = registerTestExtension(
      createGitHubPrExtension({
        temporaryRoot,
        env: {},
        fetchImpl: (async (url, init) => {
          requestUrl = String(url);
          const accept = new Headers(init?.headers).get("accept");
          if (accept === "application/vnd.github+json" && requestUrl.includes("/pulls/")) {
            const number = requestUrl.split("/").at(-1)!;
            return Response.json(createTestPullRequestMetadata(number));
          }
          return new Response(patch, { status: 200 });
        }) as GitHubFetch,
        resolveOrigin: async () => "git@github.com:modem-dev/hunk.git",
      }),
    );
    if (!registration.handler || !registration.shutdown) {
      throw new Error("Expected command and shutdown registrations.");
    }
    const output = createTestContext();
    const result = await registration.handler(scenario.args, output.context);
    if (result.kind !== "delegate") throw new Error("Expected patch delegation.");
    expect(requestUrl).toContain(scenario.expectedUrl);
    expect(result.argv[0]).toBe("patch");
    expect(result.argv[1]).toContain(scenario.expectedFilename);
    expect(result.argv.slice(2)).toEqual(["--pager"]);
    if (scenario.args[0] === "pr") {
      expect(result.review).toMatchObject({
        kind: "change-request",
        title: "Describe delegated reviews",
        repository: "modem-dev/hunk",
      });
    } else {
      expect(result.review).toBeUndefined();
    }
    expect(readFileSync(result.argv[1]!, "utf8")).toBe(patch);
    expect(output.stdout).toEqual([]);
    expect(output.stdinReads()).toBe(0);
    expect(output.stderr.join("")).toContain(scenario.expectedMessage);
    await registration.shutdown({}, {} as never);
    expect(existsSync(result.argv[1]!)).toBe(false);
  });
});

describe("GitHub branch PR dispatch", () => {
  test("discovers through a fork commit and fetches the diff from the upstream base", async () => {
    const temporaryRoot = createTestDirectory();
    const requests: string[] = [];
    const registration = registerTestExtension(
      createGitHubPrExtension({
        temporaryRoot,
        env: {},
        resolveOrigin: async () => "git@github.com:contributor/hunk.git",
        resolveCheckout: async () => ({ branch: "feature/topic", sha: "a".repeat(40) }),
        fetchImpl: (async (url, init) => {
          requests.push(String(url));
          if (String(url).includes("/commits/")) {
            return Response.json([
              {
                number: 321,
                state: "open",
                base: { repo: { full_name: "modem-dev/hunk" } },
              },
            ]);
          }
          if (new Headers(init?.headers).get("accept") === "application/vnd.github+json") {
            return Response.json(createTestPullRequestMetadata("321"));
          }
          return new Response("diff --git a/a b/a\n");
        }) as GitHubFetch,
      }),
    );
    if (!registration.handler || !registration.shutdown) {
      throw new Error("Expected command and shutdown registrations.");
    }
    const output = createTestContext();
    const result = await registration.handler(["pr"], output.context);
    if (result.kind !== "delegate") throw new Error("Expected patch delegation.");
    expect(requests[0]).toContain(`/repos/contributor/hunk/commits/${"a".repeat(40)}/pulls`);
    expect(requests[1]).toContain("/repos/modem-dev/hunk/pulls/321");
    expect(requests[2]).toContain("/repos/modem-dev/hunk/pulls/321");
    expect(result.review).toMatchObject({
      kind: "change-request",
      id: "#321",
      repository: "modem-dev/hunk",
    });
    expect(output.stderr.join("")).toContain("pull request modem-dev/hunk#321");
    await registration.shutdown({}, {} as never);
  });
});

describe("GitHub extension temporary patch lifecycle", () => {
  test("cancels after patch creation without returning a delegate", async () => {
    const temporaryRoot = createTestDirectory();
    const controller = new AbortController();
    const registration = registerTestExtension(
      createGitHubPrExtension({
        temporaryRoot,
        env: {},
        fetchImpl: createTestPullRequestFetch("diff --git a/a b/a\n"),
      }),
    );
    if (!registration.handler) throw new Error("Expected command registration.");
    let stderrWrites = 0;
    const output = createTestContext(controller.signal);
    output.context.stderr.write = async () => {
      stderrWrites += 1;
      if (stderrWrites === 2) controller.abort();
    };
    await expect(
      registration.handler(["pr", "1", "--repo", "owner/repo"], output.context),
    ).rejects.toThrow("cancelled");
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  test("retains patches while a replacement registry adopts the factory", async () => {
    const temporaryRoot = createTestDirectory();
    const extension = createGitHubPrExtension({
      temporaryRoot,
      env: {},
      fetchImpl: createTestPullRequestFetch("diff --git a/a b/a\n"),
    });
    const first = registerTestExtension(extension);
    if (!first.handler || !first.shutdown) throw new Error("Expected first registration.");
    const result = await first.handler(
      ["pr", "1", "--repo", "owner/repo"],
      createTestContext().context,
    );
    if (result.kind !== "delegate") throw new Error("Expected patch delegation.");

    const replacement = registerTestExtension(extension);
    if (!replacement.shutdown) throw new Error("Expected replacement registration.");
    await first.shutdown({}, {} as never);
    expect(existsSync(result.argv[1]!)).toBe(true);
    await replacement.shutdown({}, {} as never);
    expect(existsSync(result.argv[1]!)).toBe(false);
  });

  test("declares a private extension-contract-only workspace package", () => {
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(sourceDirectory, "..", "package.json"), "utf8"),
    ) as {
      name?: string;
      private?: boolean;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe("@hunk/gh");
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ hunkdiff: "workspace:*" });
  });
});
