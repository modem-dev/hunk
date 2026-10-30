import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseGitHubPrInvocation } from "./parsing";
import {
  classifyGitLookupFailure,
  parseGitHubRemoteRepository,
  readGitBranch,
  readGitCheckout,
  readGitHeadSha,
  readGitOrigin,
  resolveGitHubPullRequest,
  resolveGitHubRepository,
} from "./repository";

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

  test("reads a branch and reports detached HEAD clearly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-branch-test-"));
    try {
      execFileSync("git", ["init", "-b", "topic"], { cwd: directory });
      expect(await readGitBranch(directory, new AbortController().signal)).toBe("topic");
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
      execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
      execFileSync("git", ["checkout", "--detach"], { cwd: directory });
      await expect(readGitBranch(directory, new AbortController().signal)).rejects.toThrow(
        "detached HEAD",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects branch names containing terminal control characters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-hostile-branch-test-"));
    try {
      execFileSync("git", ["init", "-b", "safe"], { cwd: directory });
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/topic\u009bcontrol"], {
        cwd: directory,
      });
      await expect(readGitBranch(directory, new AbortController().signal)).rejects.toThrow(
        "terminal control characters",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads the current branch and exact HEAD together", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-checkout-test-"));
    try {
      execFileSync("git", ["init", "-b", "topic"], { cwd: directory });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
      execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      await expect(readGitHeadSha(directory, new AbortController().signal)).resolves.toBe(sha);
      await expect(readGitCheckout(directory, new AbortController().signal)).resolves.toEqual({
        branch: "topic",
        sha,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains the pushed upstream tip when local HEAD is ahead", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-gh-upstream-test-"));
    const remote = join(root, "remote.git");
    const checkout = join(root, "checkout");
    try {
      execFileSync("git", ["init", "--bare", remote]);
      execFileSync("git", ["init", "-b", "topic", checkout]);
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: checkout });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: checkout });
      execFileSync("git", ["commit", "--allow-empty", "-m", "pushed"], { cwd: checkout });
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
      execFileSync("git", ["push", "-u", "origin", "topic"], { cwd: checkout });
      const upstreamSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["commit", "--allow-empty", "-m", "local"], { cwd: checkout });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim();

      await expect(readGitCheckout(checkout, new AbortController().signal)).resolves.toEqual({
        branch: "topic",
        sha,
        upstreamSha,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("distinguishes missing Git, cancellation, and other lookup failures", async () => {
    expect(classifyGitLookupFailure({ code: "ENOENT" }, "branch").message).toContain(
      "Git is unavailable",
    );
    expect(classifyGitLookupFailure({ killed: true }, "HEAD").message).toContain("timed out");

    const controller = new AbortController();
    controller.abort();
    await expect(readGitBranch(process.cwd(), controller.signal)).rejects.toThrow("cancelled");
    await expect(readGitHeadSha(process.cwd(), controller.signal)).rejects.toThrow("cancelled");

    const directory = mkdtempSync(join(tmpdir(), "hunk-gh-not-repo-test-"));
    try {
      await expect(readGitBranch(directory, new AbortController().signal)).rejects.toThrow(
        "Git failed while reading the current branch",
      );
      await expect(readGitHeadSha(directory, new AbortController().signal)).rejects.toThrow(
        "Git failed while reading the current HEAD",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the injected origin only when a PR does not name a repository", async () => {
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

  test("resolves explicit commit repositories without reading origin", async () => {
    let originReads = 0;
    await expect(
      resolveGitHubRepository("modem-dev/hunk", "/repo", new AbortController().signal, async () => {
        originReads += 1;
        return "";
      }),
    ).resolves.toEqual({ owner: "modem-dev", repo: "hunk" });
    expect(originReads).toBe(0);
  });
});
