import fs from "node:fs";
import path from "node:path";
import { resolveGlobalConfigPath } from "./paths";
import {
  createVcsWatchSignature,
  findVcsRepoRootCandidate,
  getConfiguredVcsAdapter,
  operationFromInput,
} from "./vcs";
import type { CliInput } from "./types";

/** Return whether the current input can be rebuilt from files or VCS state without rereading stdin. */
export function canReloadInput(input: CliInput) {
  if (input.options.agentContext === "-") {
    return false;
  }

  return input.kind !== "patch" || Boolean(input.file && input.file !== "-");
}

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** Build one exact patch signature for adapter-backed review inputs. */
function vcsPatchSignature(input: Extract<CliInput, { kind: "vcs" | "show" | "stash-show" }>) {
  const adapter = getConfiguredVcsAdapter(input.options.vcs);
  const operation = operationFromInput(input);
  return createVcsWatchSignature(adapter, operation, { cwd: process.cwd() });
}
/** Compute a change-detection signature for one watchable input. */
export function computeWatchSignature(input: CliInput) {
  const parts: string[] = [input.kind];

  switch (input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      parts.push(vcsPatchSignature(input));
      break;
    case "diff":
    case "difftool":
      parts.push(statSignature(input.left), statSignature(input.right));
      break;
    case "patch":
      if (!input.file || input.file === "-") {
        throw new Error("Watch mode requires a patch file path instead of stdin.");
      }
      parts.push(statSignature(input.file));
      break;
  }

  if (input.options.agentContext && input.options.agentContext !== "-") {
    parts.push(`agent:${statSignature(input.options.agentContext)}`);
  }

  return parts.join("\n---\n");
}

/** Compute a change-detection signature over Hunk's config files (global +
 *  repo-local), so a viewer in --watch mode can notice theme/chrome edits and
 *  live-reload — mirrors the diff-input watcher but for configuration. */
export function computeConfigSignature(cwd: string = process.cwd()) {
  const parts: string[] = [];

  const globalConfigPath = resolveGlobalConfigPath();
  if (globalConfigPath) {
    parts.push(statSignature(globalConfigPath));
  }

  const repoRoot = findVcsRepoRootCandidate(cwd);
  if (repoRoot) {
    parts.push(statSignature(path.join(repoRoot, ".hunk", "config.toml")));
  }

  return parts.join("\n---\n");
}
