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
      expect(parseGitHubRemoteRepository(remote)).toEqual({
        host: "github.com",
        owner: "modem-dev",
        repo: "hunk",
      });
    }
  });

  test("parses GitHub Enterprise Cloud remote forms with their host", () => {
    for (const remote of [
      "https://acme.ghe.com/acme/app.git",
      "ssh://git@ACME.ghe.com/acme/app.git",
      "git@acme.ghe.com:acme/app.git",
      "acme.ghe.com:acme/app",
    ]) {
      expect(parseGitHubRemoteRepository(remote)).toEqual({
        host: "acme.ghe.com",
        owner: "acme",
        repo: "app",
      });
    }
  });

  test("rejects non-GitHub and malformed remotes", () => {
    for (const remote of [
      "https://gitlab.com/modem-dev/hunk.git",
      "https://github.com/modem-dev/hunk/extra.git",
      "git@github.com:modem-dev.git",
      "git@gitlab.com:modem-dev/hunk.git",
      "git@api.acme.ghe.com:acme/app.git",
      "https://acme.ghe.com.evil.com/acme/app.git",
      "https://acme.ghe.com:8443/acme/app.git",
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
    ).resolves.toEqual({ host: "github.com", owner: "modem-dev", repo: "hunk", number: "123" });
    await expect(
      resolveGitHubPullRequest(
        parseGitHubPrInvocation(["modem-dev/hunk#124"]),
        "/elsewhere",
        signal,
        resolveOrigin,
      ),
    ).resolves.toEqual({ host: "github.com", owner: "modem-dev", repo: "hunk", number: "124" });
    expect(calls).toEqual(["/repo"]);
  });

  test("resolves explicit commit repositories without reading origin", async () => {
    let originReads = 0;
    await expect(
      resolveGitHubRepository("modem-dev/hunk", "/repo", new AbortController().signal, async () => {
        originReads += 1;
        return "";
      }),
    ).resolves.toEqual({ host: "github.com", owner: "modem-dev", repo: "hunk" });
    expect(originReads).toBe(0);
  });

  test("resolves the host from the locator, origin, GH_HOST, then github.com", async () => {
    const signal = new AbortController().signal;
    const gheOrigin = async () => "git@acme.ghe.com:acme/app.git";
    const noOrigin = async () => {
      throw new Error("origin must not be read");
    };

    await expect(
      resolveGitHubPullRequest(parseGitHubPrInvocation(["7"]), "/repo", signal, gheOrigin, {
        GH_HOST: "other.ghe.com",
      }),
    ).resolves.toEqual({ host: "acme.ghe.com", owner: "acme", repo: "app", number: "7" });
    await expect(
      resolveGitHubPullRequest(
        parseGitHubPrInvocation(["https://acme.ghe.com/acme/app/pull/8"]),
        "/repo",
        signal,
        noOrigin,
        { GH_HOST: "other.ghe.com" },
      ),
    ).resolves.toEqual({ host: "acme.ghe.com", owner: "acme", repo: "app", number: "8" });
    await expect(
      resolveGitHubPullRequest(parseGitHubPrInvocation(["acme/app#9"]), "/repo", signal, noOrigin, {
        GH_HOST: "ACME.ghe.com",
      }),
    ).resolves.toEqual({ host: "acme.ghe.com", owner: "acme", repo: "app", number: "9" });
    await expect(
      resolveGitHubRepository("acme.ghe.com/acme/app", "/repo", signal, noOrigin),
    ).resolves.toEqual({ host: "acme.ghe.com", owner: "acme", repo: "app" });
    await expect(
      resolveGitHubRepository("modem-dev/hunk", "/repo", signal, gheOrigin),
    ).resolves.toEqual({ host: "github.com", owner: "modem-dev", repo: "hunk" });
  });

  test("rejects GH_HOST values that would send the token to an unsupported host", async () => {
    const signal = new AbortController().signal;
    for (const GH_HOST of ["github.example.com", "api.acme.ghe.com", "evil.com"]) {
      await expect(
        resolveGitHubRepository("acme/app", "/repo", signal, async () => "", { GH_HOST }),
      ).rejects.toThrow("unsupported GitHub host");
    }
  });
});
