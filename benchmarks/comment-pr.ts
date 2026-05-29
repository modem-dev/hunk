#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const marker = "<!-- hunk-benchmark-comment -->";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseArgs(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--body") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --body");
      }
      return { bodyPath: value };
    }
  }

  throw new Error("Usage: bun run benchmarks/comment-pr.ts --body benchmark-results/summary.md");
}

async function githubRequest(path: string, init: RequestInit = {}) {
  const token = requireEnv("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`,
    );
  }

  return response.status === 204 ? null : response.json();
}

/** Fetch every issue comment page so the marker lookup can update old bot comments. */
async function fetchAllComments(repository: string, pullRequestNumber: number) {
  const comments: Array<{ id: number; body?: string }> = [];

  for (let page = 1; ; page += 1) {
    const batch = (await githubRequest(
      `/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100&page=${page}`,
    )) as Array<{ id: number; body?: string }>;

    comments.push(...batch);

    if (batch.length < 100) {
      return comments;
    }
  }
}

const { bodyPath } = parseArgs(Bun.argv.slice(2));
const repository = requireEnv("GITHUB_REPOSITORY");
const eventPath = requireEnv("GITHUB_EVENT_PATH");
const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number: number } };
const pullRequestNumber = event.pull_request?.number;

if (!pullRequestNumber) {
  console.log("No pull request in event payload; skipping benchmark comment.");
  process.exit(0);
}

const body = readFileSync(bodyPath, "utf8");
const comments = await fetchAllComments(repository, pullRequestNumber);
const existing = comments.find((comment) => comment.body?.includes(marker));

if (existing) {
  await githubRequest(`/repos/${repository}/issues/comments/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  console.log(`Updated benchmark comment ${existing.id}.`);
} else {
  const created = (await githubRequest(
    `/repos/${repository}/issues/${pullRequestNumber}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  )) as { id: number };
  console.log(`Created benchmark comment ${created.id}.`);
}
