import { tmpdir } from "node:os";
import {
  HunkExtensionUserError,
  type ExtensionCliCommandHandler,
  type ExtensionFactory,
  type ExtensionReviewDescriptor,
} from "hunkdiff/extension";
import { assertSafeArgument } from "./errors";
import {
  fetchGitHubCommitDiff,
  fetchGitHubCompareDiff,
  fetchGitHubPullRequestDiff,
  fetchGitHubPullRequestMetadata,
  findOpenPullRequestForBranch,
} from "./github";
import {
  GITHUB_CLI_REFERENCE,
  GITHUB_COMMIT_HELP,
  GITHUB_COMPARE_HELP,
  GITHUB_HELP,
  GITHUB_PR_HELP,
} from "./help";
import {
  parseGitHubCommitInvocation,
  parseGitHubCompareInvocation,
  parseGitHubPrInvocation,
} from "./parsing";
import {
  readGitCheckout,
  readGitOrigin,
  resolveGitHubPullRequest,
  resolveGitHubRepository,
} from "./repository";
import { TemporaryPatchStore } from "./temporaryPatch";
import type { GitHubExtensionRuntime } from "./types";

interface PreparedDiff {
  bytes: Uint8Array;
  filename: string;
  patchArgs: readonly string[];
  review?: ExtensionReviewDescriptor;
}

/** Resolves and fetches one PR command into a patch-ready diff. */
async function preparePullRequest(
  args: readonly string[],
  ctx: Parameters<ExtensionCliCommandHandler>[1],
  runtime: GitHubExtensionRuntime,
): Promise<PreparedDiff | typeof GITHUB_PR_HELP> {
  const invocation = parseGitHubPrInvocation(args);
  if (invocation.help) return GITHUB_PR_HELP;
  const target = invocation.locator
    ? await resolveGitHubPullRequest(invocation, ctx.cwd, ctx.signal, runtime.resolveOrigin)
    : await (async () => {
        const originRepository = await resolveGitHubRepository(
          invocation.explicitRepository,
          ctx.cwd,
          ctx.signal,
          runtime.resolveOrigin,
        );
        const checkout = await runtime.resolveCheckout(ctx.cwd, ctx.signal);
        return findOpenPullRequestForBranch(
          originRepository,
          checkout,
          ctx.signal,
          runtime.env,
          runtime.fetchImpl,
        );
      })();
  await ctx.stderr.write(
    `Fetching GitHub pull request ${target.owner}/${target.repo}#${target.number}…\n`,
  );
  const review = await fetchGitHubPullRequestMetadata(
    target,
    ctx.signal,
    runtime.env,
    runtime.fetchImpl,
  );
  return {
    bytes: await fetchGitHubPullRequestDiff(target, ctx.signal, runtime.env, runtime.fetchImpl),
    filename: `${target.repo}-pr-${target.number}.diff`,
    patchArgs: invocation.patchArgs,
    review,
  };
}

/** Resolves and fetches one commit command into a patch-ready diff. */
async function prepareCommit(
  args: readonly string[],
  ctx: Parameters<ExtensionCliCommandHandler>[1],
  runtime: GitHubExtensionRuntime,
): Promise<PreparedDiff | typeof GITHUB_COMMIT_HELP> {
  const invocation = parseGitHubCommitInvocation(args);
  if (invocation.help) return GITHUB_COMMIT_HELP;
  const repository =
    invocation.locator.owner && invocation.locator.repo
      ? { owner: invocation.locator.owner, repo: invocation.locator.repo }
      : await resolveGitHubRepository(
          invocation.explicitRepository,
          ctx.cwd,
          ctx.signal,
          runtime.resolveOrigin,
        );
  await ctx.stderr.write(
    `Fetching GitHub commit ${repository.owner}/${repository.repo}@${invocation.locator.sha}…\n`,
  );
  return {
    bytes: await fetchGitHubCommitDiff(
      repository,
      invocation.locator.sha,
      ctx.signal,
      runtime.env,
      runtime.fetchImpl,
    ),
    filename: `${repository.repo}-commit-${invocation.locator.sha}.diff`,
    patchArgs: invocation.patchArgs,
  };
}

/** Resolves and fetches one comparison command into a patch-ready diff. */
async function prepareCompare(
  args: readonly string[],
  ctx: Parameters<ExtensionCliCommandHandler>[1],
  runtime: GitHubExtensionRuntime,
): Promise<PreparedDiff | typeof GITHUB_COMPARE_HELP> {
  const invocation = parseGitHubCompareInvocation(args);
  if (invocation.help) return GITHUB_COMPARE_HELP;
  const repository = await resolveGitHubRepository(
    invocation.explicitRepository,
    ctx.cwd,
    ctx.signal,
    runtime.resolveOrigin,
  );
  await ctx.stderr.write(
    `Fetching GitHub comparison ${repository.owner}/${repository.repo}:${invocation.base}...${invocation.head}…\n`,
  );
  return {
    bytes: await fetchGitHubCompareDiff(
      repository,
      invocation.base,
      invocation.head,
      ctx.signal,
      runtime.env,
      runtime.fetchImpl,
    ),
    filename: `${repository.repo}-compare.diff`,
    patchArgs: invocation.patchArgs,
  };
}

/** Builds the GitHub extension with injectable runtime boundaries for tests. */
export function createGitHubPrExtension(
  overrides: Partial<GitHubExtensionRuntime> = {},
): ExtensionFactory {
  const runtime: GitHubExtensionRuntime = {
    fetchImpl: overrides.fetchImpl ?? fetch,
    env: overrides.env ?? {},
    resolveOrigin: overrides.resolveOrigin ?? readGitOrigin,
    resolveCheckout: overrides.resolveCheckout ?? readGitCheckout,
    temporaryRoot: overrides.temporaryRoot ?? tmpdir(),
  };
  const patches = new TemporaryPatchStore(runtime.temporaryRoot);
  let activeRegistries = 0;

  return (hunk) => {
    activeRegistries += 1;
    let retired = false;
    const handler: ExtensionCliCommandHandler = async (args, ctx) => {
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        await ctx.stdout.write(GITHUB_HELP);
        return { kind: "exit" };
      }

      let prepared: PreparedDiff | string;
      if (args[0] === "pr") {
        prepared = await preparePullRequest(args.slice(1), ctx, runtime);
      } else if (args[0] === "commit") {
        prepared = await prepareCommit(args.slice(1), ctx, runtime);
      } else if (args[0] === "compare") {
        prepared = await prepareCompare(args.slice(1), ctx, runtime);
      } else {
        assertSafeArgument(args[0]!, "GitHub command");
        throw new HunkExtensionUserError(`Unknown GitHub command: ${args[0]}`, {
          suggestions: ["Run `hunk gh --help` to list available commands."],
        });
      }
      if (typeof prepared === "string") {
        await ctx.stdout.write(prepared);
        return { kind: "exit" };
      }
      if (ctx.signal.aborted)
        throw new HunkExtensionUserError("GitHub diff loading was cancelled.");

      const patchPath = await patches.write(prepared.filename, prepared.bytes);
      if (ctx.signal.aborted) {
        await patches.remove(patchPath);
        throw new HunkExtensionUserError("GitHub diff loading was cancelled.");
      }
      await ctx.stderr.write(
        `Opening ${prepared.bytes.byteLength.toLocaleString()} bytes in Hunk…\n`,
      );
      if (ctx.signal.aborted) {
        await patches.remove(patchPath);
        throw new HunkExtensionUserError("GitHub diff loading was cancelled.");
      }
      return {
        kind: "delegate",
        argv: ["patch", patchPath, ...prepared.patchArgs],
        ...(prepared.review === undefined ? {} : { review: prepared.review }),
      };
    };

    hunk.registerCliCommand(
      {
        name: GITHUB_CLI_REFERENCE.name,
        summary: GITHUB_CLI_REFERENCE.summary,
        usage: GITHUB_CLI_REFERENCE.usage,
      },
      handler,
    );
    hunk.on("shutdown", () => {
      if (retired) return;
      retired = true;
      activeRegistries -= 1;
      if (activeRegistries === 0) patches.cleanup();
    });
  };
}
