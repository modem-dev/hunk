/**
 * Registers the bundled `hunk gh` extension with GitHub answered from fixtures, so a browser test
 * serves `hunk gh pr <number> --web` without the network or a token.
 *
 * Load it with `--disable-extension hunk.gh --extension <this file>`: the bundled copy stands
 * aside and this one claims the same `gh` command, running the real parser, temporary patch, and
 * delegation to `hunk patch`. Every pull request serves `two-files.patch` and fixed metadata.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubPrExtension } from "@hunk/gh";

const PULL_REQUEST_PATCH = readFileSync(join(import.meta.dir, "two-files.patch"));

/** Answers one GitHub REST request with the fixture's metadata or diff. */
async function fetchTestGitHub(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const number = new URL(String(url)).pathname.split("/").at(-1);
  if (new Headers(init?.headers).get("accept") === "application/vnd.github+json") {
    return Response.json({
      title: "Serve GitHub reviews in the browser",
      html_url: `https://github.com/modem-dev/hunk/pull/${number}`,
      user: { login: "octocat" },
      state: "open",
      draft: false,
      merged: false,
      base: { ref: "main" },
      head: { ref: "feat/gh-web-review" },
    });
  }
  return new Response(PULL_REQUEST_PATCH);
}

export default createGitHubPrExtension({ env: {}, fetchImpl: fetchTestGitHub });
