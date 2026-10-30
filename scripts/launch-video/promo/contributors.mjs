// Computes a release's contributors for the promo's credits scene and
// downloads their GitHub avatars.
//
//   node scripts/launch-video/promo/contributors.mjs <workDir> [--storyboard <file>] [--to <ref>]
//
// Everyone who authored or co-authored a commit in the storyboard's
// `contributors.from..to` range is credited once, ordered by commit count.
// Bots and AI co-author trailers are excluded. Logins come from GitHub
// noreply emails, the storyboard's `aliases` (email or name -> login, or
// { login, id } when the users API is unavailable), or the GitHub commits API
// (set GITHUB_TOKEN or GH_TOKEN to lift the anonymous rate limit). A person
// with no resolvable account is credited by name with an initials tile.
//
// Output: <workDir>/contributors.json and <workDir>/avatars/<login>.<ext>.
// Review the printed table before rendering; render.mjs reads the JSON.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStoryboard, parseArgs, repoRoot } from "./storyboard.mjs";

const EXCLUDED_NAMES = [/\[bot\]$/i, /^(claude|codex|copilot|cursor)\b/i];
const EXCLUDED_EMAILS = [/@anthropic\.com$/i, /@openai\.com$/i, /\[bot\]@/i];

/** Run git in the repo and return stdout, failing loudly on a missing ref. */
function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim()}\n` +
        "Release tags and history are needed: git fetch --tags --unshallow (or --deepen).",
    );
  }
  return result.stdout;
}

/** Parse the login (and numeric id) out of a GitHub noreply address. */
export function noreplyLogin(email) {
  const match = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email ?? "");
  return match ? { login: match[2], id: match[1] ? Number(match[1]) : undefined } : undefined;
}

export function isExcluded(name, email) {
  return (
    EXCLUDED_NAMES.some((pattern) => pattern.test(name)) ||
    EXCLUDED_EMAILS.some((pattern) => pattern.test(email ?? ""))
  );
}

/** Initials for a person credited without an avatar. */
export function initialsOf(name) {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : name.slice(0, 2)).toUpperCase();
}

/** Every commit author and co-author in the range, with the commits they appear on. */
function collectCredits(from, to) {
  const log = git([
    "log",
    "--format=%H%x1f%an%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)",
    `${from}..${to}`,
  ]);
  const credits = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, name, email, trailers = ""] = line.split("\x1f");
    credits.push({ sha, name, email, kind: "author" });
    for (const trailer of trailers.split("\x1e").filter(Boolean)) {
      const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(trailer.trim());
      if (match) credits.push({ sha, name: match[1], email: match[2], kind: "co-author" });
    }
  }
  return credits.filter((credit) => !isExcluded(credit.name, credit.email));
}

async function github(path) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Fetch a person's avatar from the CDN by account id. A login-only alias is
 * resolved through the users API first (which also confirms the account), then
 * GitHub's login avatar redirect; restricted tokens may allow neither.
 */
async function fetchAvatar(person) {
  if (!person.id) {
    try {
      person.id = (await github(`/users/${person.login}`)).id;
    } catch {
      const response = await fetch(`https://github.com/${person.login}.png?size=240`);
      return response.ok ? response : undefined;
    }
  }
  return fetch(`https://avatars.githubusercontent.com/u/${person.id}?s=240&v=4`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workDir = resolve(args.positional[0] ?? join(repoRoot, ".video-work"));
  const { storyboard, path } = await loadStoryboard(args.flags.storyboard);
  const config = storyboard.contributors;
  if (!config?.from) throw new Error(`${path} has no contributors.from range`);
  const to = args.flags.to ?? config.to ?? "HEAD";
  const repo = config.repo ?? "modem-dev/hunk";
  const aliases = config.aliases ?? {};

  const credits = collectCredits(config.from, to);

  // Resolve one identity per email: noreply address, alias, then the commit's author on GitHub.
  const byEmail = new Map();
  const byName = new Map();
  for (const credit of credits) {
    if (byEmail.has(credit.email)) continue;
    const alias = aliases[credit.email] ?? aliases[credit.name];
    const identity = alias
      ? typeof alias === "string"
        ? { login: alias }
        : alias
      : noreplyLogin(credit.email);
    if (identity) {
      byEmail.set(credit.email, identity);
    } else if (credit.kind === "author") {
      const commit = await github(`/repos/${repo}/commits/${credit.sha}`);
      if (commit.author?.login) {
        byEmail.set(credit.email, { login: commit.author.login, id: commit.author.id });
      }
    }
    const resolved = byEmail.get(credit.email);
    if (resolved && credit.kind === "author") byName.set(credit.name, resolved);
  }

  // Merge credits into people: by login when known, otherwise by name.
  const people = new Map();
  for (const credit of credits) {
    const identity = byEmail.get(credit.email) ?? byName.get(credit.name);
    const key = identity ? `login:${identity.login.toLowerCase()}` : `name:${credit.name}`;
    const person = people.get(key) ?? {
      name: credit.name,
      login: identity?.login,
      id: identity?.id,
      commits: new Set(),
    };
    person.id ??= identity?.id;
    person.commits.add(credit.sha);
    people.set(key, person);
  }

  mkdirSync(join(workDir, "avatars"), { recursive: true });
  const out = [];
  for (const person of [...people.values()].sort((a, b) => b.commits.size - a.commits.size)) {
    const entry = { name: person.name, commits: person.commits.size };
    if (person.login) {
      entry.login = person.login;
      const response = await fetchAvatar(person);
      if (response?.ok) {
        const type = response.headers.get("content-type") ?? "";
        const ext = type.includes("png") ? "png" : type.includes("gif") ? "gif" : "jpg";
        entry.avatar = `${person.login}.${ext}`;
        writeFileSync(
          join(workDir, "avatars", entry.avatar),
          Buffer.from(await response.arrayBuffer()),
        );
      }
    }
    if (!entry.avatar) {
      entry.initials = initialsOf(person.name);
      if (person.login) console.warn(`no avatar for @${person.login}; crediting with initials`);
    }
    out.push(entry);
  }

  writeFileSync(join(workDir, "contributors.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${out.length} contributors in ${config.from}..${to}:`);
  for (const entry of out) {
    const who = entry.login ? `@${entry.login}` : `${entry.name} (no GitHub account found)`;
    console.log(`  ${String(entry.commits).padStart(3)}  ${who}`);
  }
  const unresolved = out.filter((entry) => !entry.login);
  if (unresolved.length > 0) {
    console.log(
      `\n${unresolved.length} credited by name with initials; add an alias in the storyboard ` +
        "if you know their GitHub login.",
    );
  }
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
