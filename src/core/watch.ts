import fs from "node:fs";
import { createVcsWatchSignature, getConfiguredVcsAdapter, operationFromInput } from "./vcs";
import type { CliInput } from "./types";

export type WatchSessionActivity = "active" | "idle";

const WATCH_IDLE_SECONDS_PATTERN = /^\d+$/;

/** Parse a watch idle timeout in whole seconds into milliseconds for timer use. */
export function parseWatchIdleAfterSeconds(value: string) {
  const trimmed = value.trim();
  if (!WATCH_IDLE_SECONDS_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid watch idle timeout: ${value}. Use a whole number of seconds like 120.`,
    );
  }

  const seconds = Number(trimmed);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Invalid watch idle timeout: ${value}.`);
  }

  return milliseconds;
}

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
